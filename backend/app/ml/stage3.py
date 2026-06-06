"""
Stage 3 Arbitrator for Fleet AI prediction pipeline.

Only activates on borderline Stage 2 scores (0.30 – 0.70).
Clear positives (>0.70) and clear negatives (<0.30) bypass entirely.

Three operations per evaluation:
  1. Temporal drift detection — first and second derivatives of signals over time
  2. Time-to-threshold projection — quadratic extrapolation to each signal's danger threshold
  3. Coarse-to-Fine Cascade — CONFIRM / CLEAR / DEFER based on multi-signal convergence

Output is always one of three verdicts:
  CONFIRM — 3+ signals project threshold crossing within 14 days → alert fires
  CLEAR   — convergence criterion not met → alert suppressed
  DEFER   — borderline evidence → vehicle enters monitoring queue
"""
from __future__ import annotations

import logging
import math
import threading
import time
from collections import deque
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

# ── Arbitrator activation band ────────────────────────────────────────────────
STAGE3_LOW = float(0.30)
STAGE3_HIGH = float(0.70)

# ── Projection window (days) ──────────────────────────────────────────────────
PROJECTION_DAYS = 14

# ── Number of signal crossings required to CONFIRM ───────────────────────────
CONFIRM_THRESHOLD = 3

# ── Minimum observations in buffer before computing derivatives ───────────────
MIN_OBSERVATIONS = 4

# ── Maximum buffer age — readings older than this are dropped (days) ──────────
MAX_BUFFER_AGE_DAYS = 30.0

# ── Per-signal danger thresholds ─────────────────────────────────────────────
# Increasing direction: signal APPROACHES threshold from below.
# Decreasing direction: signal APPROACHES threshold from above (value in tuple is negative sentinel).
# Format: (threshold, direction) where direction is +1 (rising toward danger) or -1 (falling toward danger)
_SIGNAL_THRESHOLDS: dict[str, tuple[float, int]] = {
    # Hub temperatures — rising toward danger (°C)
    "hubTempFL":           (95.0,  +1),
    "hubTempFR":           (95.0,  +1),
    "hubTempRL":           (95.0,  +1),
    "hubTempRR":           (95.0,  +1),
    # Coolant — rising toward danger (°C)
    "coolantTemp":         (105.0, +1),
    # Oil temperature — rising toward danger (°C)
    "oilTemp":             (130.0, +1),
    # Turbo bearing — rising toward danger (°C)
    "turboBearingTemp":    (150.0, +1),
    # Battery voltage — falling toward danger (V)
    "batteryVoltage":      (12.0,  -1),
    # DPF soot — rising toward regeneration trigger (%)
    "dpfSootLoad":         (80.0,  +1),
    # Bearing frequency score — rising toward fault band (0–1)
    "bearingFreqScore":    (0.70,  +1),
    # Drivetrain vibration — rising toward fault (0–1)
    "drivetrainFreqScore": (0.65,  +1),
    # Vibration asymmetry — rising (imbalance signature)
    "vibrationAsymmetry":  (2.50,  +1),
    # Air brake pressure decay — rising (leak getting worse, kPa/min)
    "airPressureDecayRate":(3.0,   +1),
    # Oil dilution — rising (% fuel-in-oil)
    "oilDilutionPct":      (4.0,   +1),
    # EGR cooler delta — rising (°C)
    "egrCoolerDelta":      (25.0,  +1),
    # SCR efficiency — falling (%)
    "scrEfficiency":       (85.0,  -1),
}

# Signals that are "high importance" — weighted double in convergence counting
_HIGH_IMPORTANCE = {"hubTempFL", "hubTempFR", "hubTempRL", "hubTempRR", "coolantTemp", "bearingFreqScore"}


# ── Observation record ────────────────────────────────────────────────────────

class _Obs:
    __slots__ = ("ts_days", "value")

    def __init__(self, ts_days: float, value: float) -> None:
        self.ts_days = ts_days
        self.value = value


# ── Per-vehicle signal buffer ─────────────────────────────────────────────────

class SignalHistory:
    """Circular buffer for one signal on one vehicle."""

    def __init__(self, maxlen: int = 500) -> None:
        self._buf: deque[_Obs] = deque(maxlen=maxlen)

    def push(self, ts_days: float, value: float) -> None:
        self._buf.append(_Obs(ts_days, value))

    def prune(self, cutoff_days: float) -> None:
        while self._buf and self._buf[0].ts_days < cutoff_days:
            self._buf.popleft()

    def as_arrays(self) -> tuple[np.ndarray, np.ndarray]:
        if not self._buf:
            return np.array([]), np.array([])
        ts = np.array([o.ts_days for o in self._buf], dtype=np.float64)
        vals = np.array([o.value for o in self._buf], dtype=np.float64)
        return ts, vals

    def __len__(self) -> int:
        return len(self._buf)


# ── Global temporal buffer ────────────────────────────────────────────────────

class TemporalBuffer:
    """
    In-memory store of SignalHistory objects, keyed by (vehicle_id, signal_name).
    Thread-safe via a single lock per instance.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # vehicle_id → signal_name → SignalHistory
        self._store: dict[str, dict[str, SignalHistory]] = {}
        self._last_prune: float = 0.0

    def push(self, vehicle_id: str, signal: str, ts_days: float, value: float) -> None:
        with self._lock:
            vh = self._store.setdefault(vehicle_id, {})
            if signal not in vh:
                vh[signal] = SignalHistory()
            vh[signal].push(ts_days, value)

    def get(self, vehicle_id: str, signal: str) -> Optional[SignalHistory]:
        with self._lock:
            return self._store.get(vehicle_id, {}).get(signal)

    def prune_old(self, now_days: float) -> None:
        """Drop observations older than MAX_BUFFER_AGE_DAYS. Rate-limited to once/hour."""
        if now_days - self._last_prune < 1.0 / 24:
            return
        cutoff = now_days - MAX_BUFFER_AGE_DAYS
        with self._lock:
            for vh in self._store.values():
                for hist in vh.values():
                    hist.prune(cutoff)
        self._last_prune = now_days

    def vehicle_count(self) -> int:
        with self._lock:
            return len(self._store)


# Module-level singleton buffer shared across requests
_buffer = TemporalBuffer()


# ── Derivative computation ────────────────────────────────────────────────────

def _compute_derivatives(
    ts: np.ndarray, values: np.ndarray
) -> tuple[float, float]:
    """
    Fit a quadratic polynomial to (ts, values) and return the first and second
    derivatives evaluated at the most recent timestamp.

    Returns (velocity_per_day, acceleration_per_day2).
    Falls back to linear fit when fewer than 6 points (insufficient for stable quadratic).
    Returns (0.0, 0.0) on any failure.
    """
    n = len(ts)
    if n < 2:
        return 0.0, 0.0

    # Normalize timestamps to [0, span] to improve numerical conditioning
    t0 = ts[0]
    t_norm = ts - t0
    t_end = float(t_norm[-1])

    if t_end < 1e-9:
        return 0.0, 0.0

    try:
        if n >= 6:
            coeffs = np.polyfit(t_norm, values, 2)  # [a, b, c] for a*t² + b*t + c
            # First derivative: 2a*t + b  evaluated at t_end
            velocity = float(2.0 * coeffs[0] * t_end + coeffs[1])
            # Second derivative: 2a (constant)
            acceleration = float(2.0 * coeffs[0])
        else:
            # Linear: p[0]*t + p[1]
            coeffs = np.polyfit(t_norm, values, 1)
            velocity = float(coeffs[0])
            acceleration = 0.0
        return velocity, acceleration
    except (np.linalg.LinAlgError, ValueError):
        return 0.0, 0.0


# ── Threshold crossing projection ─────────────────────────────────────────────

def _project_crossing(
    current_val: float,
    velocity: float,
    acceleration: float,
    threshold: float,
    direction: int,
) -> Optional[float]:
    """
    Estimate days until current_val crosses threshold in the given direction.

    direction=+1: danger when value rises above threshold (current_val should be < threshold).
    direction=-1: danger when value falls below threshold (current_val should be > threshold).

    Solves: current_val + v*t + 0.5*a*t² = threshold  (quadratic)
    Returns days to crossing, or None if no positive crossing within PROJECTION_DAYS.
    """
    # Already past threshold — crossing has already happened
    if direction == +1 and current_val >= threshold:
        return 0.0
    if direction == -1 and current_val <= threshold:
        return 0.0

    # Signal moving away from threshold — no crossing
    delta = (threshold - current_val) * direction  # positive means distance to threshold
    if delta <= 0:
        return None

    # Linear case (acceleration negligible)
    if abs(acceleration) < 1e-9:
        if velocity * direction <= 0:
            return None  # moving away or flat
        t = delta / (velocity * direction)
        return float(t) if 0 < t <= PROJECTION_DAYS else None

    # Quadratic case: 0.5*a*t² + v*t - delta*direction = 0
    # => a_half*t² + v*t - delta = 0  where delta is in direction-adjusted space
    a_half = 0.5 * acceleration * direction
    b_lin = velocity * direction
    c_const = -delta  # we want a_half*t² + b_lin*t + c_const = 0

    disc = b_lin * b_lin - 4.0 * a_half * c_const
    if disc < 0:
        return None

    sqrt_disc = math.sqrt(disc)
    roots = []
    if abs(a_half) > 1e-12:
        r1 = (-b_lin + sqrt_disc) / (2.0 * a_half)
        r2 = (-b_lin - sqrt_disc) / (2.0 * a_half)
        roots = [r for r in (r1, r2) if r > 1e-6]
    else:
        # Degenerate — treat as linear
        if abs(b_lin) > 1e-9:
            r = -c_const / b_lin
            if r > 1e-6:
                roots = [r]

    if not roots:
        return None

    t_min = min(roots)
    return float(t_min) if t_min <= PROJECTION_DAYS else None


# ── Main arbitrator ───────────────────────────────────────────────────────────

class Stage3Arbitrator:
    """
    Post-processing layer after Stage 2.  Only called when 0.30 ≤ stage2_score ≤ 0.70.
    """

    def evaluate(
        self,
        vehicle_id: str,
        stage2_score: float,
        current_metrics: dict,
        window_stats: dict | None = None,
        timestamp: float | None = None,
    ) -> dict:
        """
        Evaluate a borderline vehicle.

        Parameters
        ----------
        vehicle_id    : unique vehicle identifier
        stage2_score  : Stage 2 output probability (must be in [0.30, 0.70])
        current_metrics : dict of signal_name → float from feature extraction
        window_stats  : optional window statistics (not currently used for projection)
        timestamp     : Unix epoch float; defaults to now

        Returns
        -------
        {
          "verdict":     "CONFIRM" | "CLEAR" | "DEFER",
          "reason":      str,
          "projections": {signal_name: days_to_crossing | None},
          "derivatives": {signal_name: {"velocity": float, "acceleration": float}},
          "convergingSignals": int,
          "bufferObs":   {signal_name: int},
        }
        """
        now_ts = timestamp if timestamp is not None else time.time()
        now_days = now_ts / 86400.0

        # Update temporal buffer with current readings
        self._ingest(vehicle_id, current_metrics, now_days)
        _buffer.prune_old(now_days)

        # Compute derivatives and projections for each tracked signal
        projections: dict[str, Optional[float]] = {}
        derivatives: dict[str, dict[str, float]] = {}
        obs_counts: dict[str, int] = {}

        for signal, (threshold, direction) in _SIGNAL_THRESHOLDS.items():
            raw_val = current_metrics.get(signal)
            if raw_val is None:
                continue

            current_val = float(raw_val)
            hist = _buffer.get(vehicle_id, signal)
            n_obs = len(hist) if hist else 0
            obs_counts[signal] = n_obs

            if hist is None or n_obs < MIN_OBSERVATIONS:
                projections[signal] = None
                continue

            ts_arr, val_arr = hist.as_arrays()
            velocity, acceleration = _compute_derivatives(ts_arr, val_arr)

            derivatives[signal] = {
                "velocity": round(velocity, 6),
                "acceleration": round(acceleration, 6),
            }

            days = _project_crossing(current_val, velocity, acceleration, threshold, direction)
            projections[signal] = round(days, 2) if days is not None else None

        # Count converging signals (those projecting a crossing within the window)
        # High-importance signals count double toward the CONFIRM threshold
        converging_signals = [s for s, d in projections.items() if d is not None]
        weighted_count = sum(
            2 if s in _HIGH_IMPORTANCE else 1
            for s in converging_signals
        )

        # Classify data sufficiency
        signals_with_history = sum(1 for c in obs_counts.values() if c >= MIN_OBSERVATIONS)
        total_tracked = sum(1 for s in _SIGNAL_THRESHOLDS if s in current_metrics)

        # ── Decision cascade ──────────────────────────────────────────────────
        if signals_with_history < 2:
            verdict = "DEFER"
            reason = (
                f"Insufficient temporal history — only {signals_with_history} signal(s) have "
                f"{MIN_OBSERVATIONS}+ observations. Vehicle queued for continued monitoring."
            )

        elif weighted_count >= CONFIRM_THRESHOLD:
            # At least CONFIRM_THRESHOLD weighted signal crossings projected
            crossing_names = ", ".join(
                f"{s} in {projections[s]:.1f}d" for s in converging_signals
            )
            verdict = "CONFIRM"
            reason = (
                f"{len(converging_signals)} signal(s) project threshold crossing within "
                f"{PROJECTION_DAYS} days (weighted score {weighted_count}): {crossing_names}. "
                f"Stage 2 score {stage2_score:.3f} confirmed — alert elevated."
            )

        elif weighted_count == 0:
            # No signals converging — check if derivatives show stability
            accel_magnitudes = [
                abs(d["acceleration"]) for d in derivatives.values()
            ]
            avg_accel = sum(accel_magnitudes) / len(accel_magnitudes) if accel_magnitudes else 0.0
            if avg_accel < 0.5:
                verdict = "CLEAR"
                reason = (
                    f"No signals projecting threshold crossing within {PROJECTION_DAYS} days. "
                    f"Signal derivatives stable (avg |acceleration|={avg_accel:.3f}/day²). "
                    f"Stage 2 score {stage2_score:.3f} suppressed — continue routine monitoring."
                )
            else:
                verdict = "DEFER"
                reason = (
                    f"No threshold crossings projected but signal acceleration is non-trivial "
                    f"(avg |accel|={avg_accel:.3f}/day²). Monitoring for emerging trend."
                )

        else:
            # 1 or 2 weighted signals converging — borderline
            crossing_names = ", ".join(
                f"{s} in {projections[s]:.1f}d" for s in converging_signals
            )
            verdict = "DEFER"
            reason = (
                f"{len(converging_signals)} signal(s) converging toward threshold "
                f"(weighted {weighted_count}, need {CONFIRM_THRESHOLD} to CONFIRM): {crossing_names}. "
                f"Vehicle deferred to elevated monitoring queue."
            )

        return {
            "verdict": verdict,
            "reason": reason,
            "projections": projections,
            "derivatives": derivatives,
            "convergingSignals": len(converging_signals),
            "weightedConvergence": weighted_count,
            "bufferObs": obs_counts,
        }

    # ── Buffer ingestion ──────────────────────────────────────────────────────

    @staticmethod
    def _ingest(vehicle_id: str, current_metrics: dict, now_days: float) -> None:
        for signal in _SIGNAL_THRESHOLDS:
            raw = current_metrics.get(signal)
            if raw is None:
                continue
            try:
                _buffer.push(vehicle_id, signal, now_days, float(raw))
            except (TypeError, ValueError):
                pass


# ── Module-level singleton ────────────────────────────────────────────────────

_arbitrator = Stage3Arbitrator()


def evaluate_stage3(
    vehicle_id: str,
    stage2_score: float,
    current_metrics: dict,
    window_stats: dict | None = None,
    timestamp: float | None = None,
) -> Optional[dict]:
    """
    Public entry point.  Returns None if stage2_score is outside the arbitrator band.
    Otherwise returns the full arbitrator result dict.
    """
    if not (STAGE3_LOW <= stage2_score <= STAGE3_HIGH):
        return None
    try:
        return _arbitrator.evaluate(
            vehicle_id=vehicle_id,
            stage2_score=stage2_score,
            current_metrics=current_metrics,
            window_stats=window_stats,
            timestamp=timestamp,
        )
    except Exception as exc:
        logger.warning("[stage3] evaluate error for %s: %s", vehicle_id, exc)
        return None


def get_stage3_buffer_stats() -> dict:
    return {
        "vehiclesTracked": _buffer.vehicle_count(),
        "activationBand": [STAGE3_LOW, STAGE3_HIGH],
        "projectionDays": PROJECTION_DAYS,
        "confirmThreshold": CONFIRM_THRESHOLD,
    }
