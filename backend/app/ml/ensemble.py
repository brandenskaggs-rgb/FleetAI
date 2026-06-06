"""
Ensemble risk scorer for Fleet AI.

Combines five independent signal sources into a single riskProbability:
  - Pretrained HGB+RF prior        (weight: up to 0.20)
  - Isolation Forest anomaly score  (weight: up to 0.30)
  - Welford z-score breach          (weight: 0.30)
  - Threshold hard-limit breaches   (weight: 0.12)
  - DTC fault-tree risk             (weight: 0.08)

Fleet-normalization boost added post-blend (capped at +0.25).
Multivariate stress boost capped at +0.15.
"""
from __future__ import annotations
import math
import logging
from typing import Optional

logger = logging.getLogger(__name__)

# ── Weight constants ──────────────────────────────────────────────────────────
_W_PRETRAINED = 0.20   # cold-start prior; decays in confidence as live data grows
_W_IF         = 0.30   # per-vehicle anomaly detector
_W_WELFORD    = 0.30   # per-vehicle z-score drift
_W_THRESHOLD  = 0.12   # hard operating limit breaches
_W_DTC        = 0.08   # OBD-II / J1939 fault codes

# Hard operating limits — breaching any raises threshold score
_HARD_LIMITS: dict[str, tuple[Optional[float], Optional[float]]] = {
    # ── Original OBD-II / J1939 limits ───────────────────────────────────────
    "coolantTemp":            (None, 105.0),   # °C
    "oilTemp":                (None, 140.0),   # °C
    "batteryVoltage":         (11.5, 15.5),    # V
    "rpm":                    (None, 6000.0),
    "engineLoad":             (None, 95.0),    # %
    "dpfSootLoad":            (None, 90.0),    # %
    "throttlePos":            (None, 99.0),    # % WOT
    "intakeManifoldPressure": (None, 250.0),   # kPa
    "fuelLevel":              (5.0,  None),    # % near-empty

    # ── Wheel hub temperatures (bearing failure threshold: 80°C+) ────────────
    "hubTempFL":              (None, 85.0),    # °C — early bearing failure
    "hubTempFR":              (None, 85.0),
    "hubTempRL":              (None, 85.0),
    "hubTempRR":              (None, 85.0),
    "hubTempMax":             (None, 90.0),    # derived max — critical at 90°C
    "hubTempDelta":           (None, 20.0),    # °C imbalance — one wheel running hot

    # ── Differential temperatures ─────────────────────────────────────────────
    "diffTempFront":          (None, 120.0),   # °C
    "diffTempRear":           (None, 120.0),   # °C

    # ── Air brake system ─────────────────────────────────────────────────────
    "airPressureCurrent":     (690.0, None),   # kPa — min safe operating pressure
    "airPressureDecayRate":   (None, 3.0),     # kPa/min at key-off — FMCSA limit ~2kPa/min

    # ── OEM locked / Chassis CAN signals ─────────────────────────────────────
    "dpfAshLoad":             (None, 100.0),   # % — at 100% requires forced regen
    "scrEfficiency":          (70.0, None),    # % — below 70% = emissions failure
    "oilDilutionPct":         (None, 3.5),     # % fuel-in-oil — damaging at 5%+
    "coolantPressureDecay":   (None, 2.0),     # kPa/min — air dryer or valve leak
    "turboBearingTemp":       (None, 180.0),   # °C — turbo failure threshold
    "cylinderMisfireCount":   (None, 50.0),    # rolling count — P0300 fires at 50
    "injectorBalanceVariance":(None, 8.0),     # mg/stroke variance — injector wear

    # ── Accelerometer / vibration ─────────────────────────────────────────────
    "bearingFreqScore":       (None, 0.65),    # 0-1 — high energy in bearing bands
    "drivetrainFreqScore":    (None, 0.60),    # 0-1 — driveshaft harmonic energy
    "engineMountScore":       (None, 0.70),    # 0-1 — idle low-freq vibration
    "accelZRms":              (None, 0.8),     # g RMS — severe vertical vibration
}

# Welford z-score thresholds → contribution
_Z_SCORE_MAP = [
    (4.0, 1.0),
    (3.0, 0.75),
    (2.5, 0.55),
    (2.0, 0.38),
    (1.5, 0.20),
    (1.0, 0.10),
]


def _welford_score(welford_zscores: dict[str, float]) -> float:
    """Aggregate per-metric z-scores into a 0-1 score. Uses top-3 worst."""
    if not welford_zscores:
        return 0.0
    scores = []
    for z in welford_zscores.values():
        z_abs = abs(z)
        s = 0.0
        for threshold, contribution in _Z_SCORE_MAP:
            if z_abs >= threshold:
                s = contribution
                break
        scores.append(s)
    if not scores:
        return 0.0
    scores.sort(reverse=True)
    top = scores[:3]
    weights = [0.50, 0.30, 0.20]
    return round(min(1.0, sum(s * w for s, w in zip(top, weights))), 4)


def _threshold_score(current_metrics: dict[str, Optional[float]]) -> float:
    """Return 0-1 score based on how many hard limits are breached."""
    if not current_metrics:
        return 0.0
    breaches = 0
    critical_breach = False
    for metric, (low, high) in _HARD_LIMITS.items():
        val = current_metrics.get(metric)
        if val is None:
            continue
        if (low is not None and val < low) or (high is not None and val > high):
            breaches += 1
            margin = 0.0
            if high is not None and val > high:
                margin = (val - high) / max(high, 1.0)
            elif low is not None and val < low:
                margin = (low - val) / max(low, 1.0)
            if margin > 0.10:
                critical_breach = True
    if breaches == 0:
        return 0.0
    base = min(1.0, breaches * 0.25)
    if critical_breach:
        base = min(1.0, base + 0.30)
    return round(base, 4)


def _dtc_score(dtc_analysis: Optional[dict]) -> float:
    if not dtc_analysis:
        return 0.0
    return round(min(1.0, float(dtc_analysis.get("risk_score", 0.0))), 4)


def _blend(
    pretrained_score: Optional[float],
    if_score: Optional[float],
    welford_s: float,
    threshold_s: float,
    dtc_s: float,
    sample_count: int,
) -> tuple[float, dict]:
    """
    Weighted blend. Missing signals redistribute their weight proportionally.

    The pretrained weight shrinks linearly to 0 once the vehicle has accumulated
    ≥500 samples — at that point, per-vehicle signals fully take over.
    """
    # Pretrained prior decays as live data grows (full trust below 50 samples,
    # zero contribution at 500+ samples)
    pt_trust = max(0.0, min(1.0, 1.0 - (sample_count - 50) / 450)) if sample_count > 50 else 1.0
    w_pt = _W_PRETRAINED * pt_trust if pretrained_score is not None else 0.0
    w_if = _W_IF if if_score is not None else 0.0

    # Redistribute missing weights proportionally to the remaining signals
    missing = (_W_PRETRAINED - w_pt) + (_W_IF - w_if)
    # Remaining live-signal weights
    w_w = _W_WELFORD
    w_t = _W_THRESHOLD
    w_d = _W_DTC
    if missing > 0:
        live_total = w_w + w_t + w_d
        if live_total > 0:
            factor = (live_total + missing) / live_total
            w_w *= factor
            w_t *= factor
            w_d *= factor

    score = (
        w_pt * (pretrained_score or 0.0)
        + w_if * (if_score or 0.0)
        + w_w * welford_s
        + w_t * threshold_s
        + w_d * dtc_s
    )
    return round(min(1.0, score), 4), {
        "pretrained": round(w_pt, 4),
        "isolationForest": round(w_if, 4),
        "welford": round(w_w, 4),
        "threshold": round(w_t, 4),
        "dtc": round(w_d, 4),
    }


def _confidence(
    sample_count: int,
    if_trained: bool,
    welford_count: int,
    pretrained_available: bool,
) -> float:
    data_conf = min(1.0, sample_count / 200)
    model_conf = 0.85 if if_trained else (0.55 if pretrained_available else 0.35)
    welford_conf = min(1.0, welford_count / 100) if welford_count else 0.25
    return round(data_conf * 0.40 + model_conf * 0.40 + welford_conf * 0.20, 3)


def _prediction_label(score: float, confidence: float, vehicle_class: str = "") -> str:
    if confidence < 0.3:
        return "insufficient_data"
    if score >= 0.75:
        return "failure_imminent"
    if score >= 0.55:
        return "maintenance_soon"
    thresh = _CLASS_STAGE1_THRESHOLDS.get(vehicle_class.lower(), 0.35) if vehicle_class else 0.35
    if score >= thresh:
        return "monitor_closely"
    return "healthy"


def _advisory_language(
    label: str,
    top_metrics: list[str],
    dtc_analysis: Optional[dict],
    fleet_norm: Optional[dict],
) -> str:
    if label == "insufficient_data":
        return "Insufficient telemetry data to generate a reliable prediction. Continue monitoring."

    fleet_summary = fleet_norm.get("_summary", {}) if fleet_norm else {}
    worst_fleet_metric = fleet_summary.get("worst_metric")
    worst_z = fleet_summary.get("worst_z", 0.0)

    dtc_systems = dtc_analysis.get("systems_affected", []) if dtc_analysis else []
    dtc_patterns = dtc_analysis.get("co_occurrence_patterns", []) if dtc_analysis else []

    parts = []
    if label == "failure_imminent":
        parts.append("CRITICAL: High probability of imminent failure detected.")
    elif label == "maintenance_soon":
        parts.append("Maintenance recommended within the next service interval.")
    elif label == "monitor_closely":
        parts.append("Anomalous patterns detected. Monitor vehicle closely.")
    else:
        parts.append("Vehicle operating within normal parameters.")

    if top_metrics:
        parts.append(f"Elevated signals in: {', '.join(top_metrics[:3])}.")
    if dtc_systems:
        parts.append(f"Active fault codes affecting: {', '.join(dtc_systems)}.")
    if dtc_patterns:
        parts.append(f"Co-occurring fault pattern: {dtc_patterns[0]}.")
    if worst_fleet_metric and abs(worst_z) > 2.0:
        direction = "above" if worst_z > 0 else "below"
        parts.append(f"{worst_fleet_metric} is {abs(worst_z):.1f}σ {direction} fleet average.")

    return " ".join(parts)


# ── Phase 1B: Per-class risk multipliers ──────────────────────────────────────
# Calibrated from v4.1 eval: heavy_duty F1=0.965, others ~0.80
# Non-heavy classes have higher FP rates — lift their effective threshold by
# reducing the raw score so Stage 1 fires less eagerly on those classes.
_CLASS_RISK_MULTIPLIER: dict[str, float] = {
    "heavy_duty_j1939":  1.00,   # best-calibrated class — no adjustment
    "medium_duty":       0.92,   # slight reduction to raise effective threshold
    "cargo_van":         0.90,
    "light_duty_truck":  0.88,
    "passenger_car":     0.86,
}
_CLASS_RISK_MULTIPLIER_DEFAULT = 0.92  # unknown class → conservative

# Per-class Stage 1 operating thresholds (post-multiplier scores).
# The class multiplier suppresses scores for lighter vehicles, so a flat 0.35
# threshold would miss most real failures in those classes (3-21% recall vs
# 90-92% AUC). Lower thresholds restore recall without loosening the gate for
# heavy-duty, which is the primary use case.
_CLASS_STAGE1_THRESHOLDS: dict[str, float] = {
    "heavy_duty_j1939": 0.35,   # baseline — well-calibrated
    "medium_duty":      0.30,   # 0.35 × 0.92 multiplier ≈ 0.322; nudged lower to recover recall
    "cargo_van":        0.12,   # gasoline vans score 0.10-0.22 range; must go low to recover recall
    "light_duty_truck": 0.24,   # 0.35 × 0.88 ≈ 0.308; lighter vehicles need lower bar
    "passenger_car":    0.20,   # 0.35 × 0.86 ≈ 0.301; lowest recall class needs most reduction
}
_CLASS_STAGE1_THRESHOLD_DEFAULT = 0.30


def apply_class_risk_multiplier(score: float, vehicle_class: str) -> float:
    """
    Phase 1B: Scale risk score by per-class multiplier.

    Heavy-duty trucks are the best-calibrated class (F1=0.965) and need no
    adjustment. Lighter classes show higher false-positive rates in v4.1 eval,
    so we multiply their raw score down — equivalent to raising their effective
    Stage 1 threshold without touching any trained weights.
    """
    mult = _CLASS_RISK_MULTIPLIER.get(vehicle_class.lower(), _CLASS_RISK_MULTIPLIER_DEFAULT)
    return round(min(1.0, score * mult), 4)


def get_class_threshold(vehicle_class: str) -> float:
    """
    Return the Stage 1 firing threshold for this vehicle class.

    Lighter classes have lower thresholds because the Phase 1B multiplier
    already suppresses their raw scores; without a matching threshold reduction
    their 90-92% AUC never converts into actionable alerts.
    """
    return _CLASS_STAGE1_THRESHOLDS.get(
        vehicle_class.lower() if vehicle_class else "",
        _CLASS_STAGE1_THRESHOLD_DEFAULT,
    )


# ── Phase 3A: Multi-signal hard gate ──────────────────────────────────────────
# Before a score can cross the Stage 1 threshold, at least 3 of the 5 signals
# must be individually elevated (≥ _GATE_SIGNAL_THRESHOLD).
# This prevents any single noisy sensor from driving a false alert.
_GATE_SIGNAL_THRESHOLD = 0.35
_GATE_MIN_SIGNALS      = 3


def multi_signal_gate(
    score: float,
    pretrained_score: Optional[float],
    if_score: Optional[float],
    welford_score: float,
    threshold_score: float,
    dtc_score: float,
    stage1_threshold: float = 0.35,
) -> tuple[float, int]:
    """
    Phase 3A: Hard-gate the ensemble score when multi-signal agreement is low.

    Returns (gated_score, active_signal_count).

    Logic:
      • Count signals ≥ _GATE_SIGNAL_THRESHOLD
      • If score >= stage1_threshold but fewer than _GATE_MIN_SIGNALS are active:
          - 0–1 active → cap score at 0.28 (below Stage 1 entirely)
          - 2   active → cap score at stage1_threshold - 0.06 (just below Stage 1)
      • If _GATE_MIN_SIGNALS or more active → no adjustment
    """
    signals = [
        pretrained_score if pretrained_score is not None else 0.0,
        if_score         if if_score is not None         else 0.0,
        welford_score,
        threshold_score,
        dtc_score,
    ]
    active = sum(1 for s in signals if s >= _GATE_SIGNAL_THRESHOLD)

    if score < stage1_threshold or active >= _GATE_MIN_SIGNALS:
        return score, active

    if active <= 1:
        gated = min(score, 0.28)
    else:  # active == 2
        gated = min(score, max(0.28, stage1_threshold - 0.06))

    return round(gated, 4), active


def _signal_agreement(scores: list[float]) -> float:
    """
    Coefficient of variation across live signal scores → agreement index.
    High agreement (close to 1.0) means signals converge — real failure.
    Low agreement (close to 0.0) means one signal outlier — likely noise.
    """
    valid = [s for s in scores if s is not None]
    if len(valid) < 2:
        return 0.5  # not enough signals to measure agreement
    mean = sum(valid) / len(valid)
    if mean < 1e-9:
        return 1.0  # all near-zero → unanimous healthy
    variance = sum((s - mean) ** 2 for s in valid) / len(valid)
    std = variance ** 0.5
    cv = std / mean
    return round(max(0.0, min(1.0, 1.0 - cv)), 4)


def compute_ensemble(
    if_score: Optional[float],
    welford_zscores: dict[str, float],
    current_metrics: dict,
    dtc_analysis: Optional[dict],
    fleet_norm: Optional[dict],
    fleet_boost: float,
    sample_count: int,
    if_trained: bool,
    welford_count: int,
    multivariate_stress: Optional[dict] = None,
    pretrained_score: Optional[float] = None,
    vehicle_class: str = "",
) -> dict:
    """
    Produce the final ensemble prediction.

    Returns:
      {
        "riskProbability": float (0-1),
        "prediction": str,
        "confidence": float (0-1),
        "advisoryText": str,
        "topMetrics": list[str],
        "components": {
          "pretrained": float | None,
          "isolationForest": float | None,
          "welford": float,
          "threshold": float,
          "dtc": float,
          "fleetBoost": float,
          "mvStress": float,
          "effectiveWeights": dict,
        }
      }
    """
    w_score = _welford_score(welford_zscores)
    t_score = _threshold_score(current_metrics)
    d_score = _dtc_score(dtc_analysis)

    blended, effective_weights = _blend(pretrained_score, if_score, w_score, t_score, d_score, sample_count)

    mv_boost = 0.0
    if multivariate_stress:
        max_stress = max(multivariate_stress.values())
        # Hub bearing and drivetrain vibration are high-confidence signals —
        # give them slightly higher boost weight when confirmed by FFT data
        high_conf_stress = max(
            multivariate_stress.get("hub_bearing", 0.0),
            multivariate_stress.get("drivetrain_vibration", 0.0),
            multivariate_stress.get("air_brake", 0.0),
        )
        mv_boost = round(min(0.20, max_stress * 0.18 + high_conf_stress * 0.06), 4)

    # Signal agreement — how consistently all five sources agree
    signal_agreement = _signal_agreement([
        pretrained_score, if_score, w_score, t_score, d_score
    ])

    raw_total = min(1.0, blended + fleet_boost + mv_boost)

    # Phase 3A — multi-signal hard gate (prevent single-signal false alarms)
    gated_total, active_signals = multi_signal_gate(
        raw_total, pretrained_score, if_score, w_score, t_score, d_score
    )

    # Phase 1B — per-class risk multiplier (calibrate FP rate by vehicle class)
    total = apply_class_risk_multiplier(gated_total, vehicle_class) if vehicle_class else gated_total

    conf = _confidence(sample_count, if_trained, welford_count, pretrained_score is not None)
    label = _prediction_label(total, conf, vehicle_class)

    top_metrics = sorted(
        welford_zscores.keys(),
        key=lambda k: abs(welford_zscores[k]),
        reverse=True,
    )[:5]

    advisory = _advisory_language(label, top_metrics, dtc_analysis, fleet_norm)

    return {
        "riskProbability": round(total, 4),
        "prediction": label,
        "confidence": conf,
        "advisoryText": advisory,
        "topMetrics": top_metrics,
        "signalAgreement": signal_agreement,
        "components": {
            "pretrained": pretrained_score,
            "isolationForest": if_score,
            "welford": w_score,
            "threshold": t_score,
            "dtc": d_score,
            "fleetBoost": fleet_boost,
            "mvStress": mv_boost,
            "effectiveWeights": effective_weights,
            # Phase 3A gate metadata
            "activeSignals": active_signals,
            "rawScoreBeforeGate": round(raw_total, 4),
        },
    }
