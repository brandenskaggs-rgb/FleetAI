"""
Feature engineering for Fleet AI ML models.
Extracts statistical features from raw telemetry sample arrays.
"""
from __future__ import annotations
import math
from datetime import datetime, timezone
from typing import Optional

METRIC_KEYS = [
    # ── Core OBD-II / J1939 (original 15) ────────────────────────────────────
    "rpm", "vehicleSpeed", "coolantTemp", "oilTemp",
    "batteryVoltage", "engineLoad", "engineTorque", "fuelRate",
    "intakeAirTemp", "maf", "throttlePos", "intakeManifoldPressure",
    "dpfSootLoad", "ambientTemp", "fuelLevel",

    # ── Chassis CAN / Geotab GO9 multi-network (Tier 2) ──────────────────────
    "absActivationFreq",       # ABS events per 100km — brake/tire wear
    "suspensionHeightDev",     # Air suspension deviation from target (mm)
    "stabilityControlFreq",    # ESC interventions per 100km — handling issues
    "steeringAngleDrift",      # Steering angle sensor offset drift (degrees)

    # ── OEM locked signals via Geotab custom CAN rules (Tier 2) ──────────────
    "injectorBalanceVariance", # Variance across cylinder injector balance rates
    "cylinderMisfireCount",    # Total misfires rolling window
    "egrCoolerDelta",          # EGR cooler inlet vs outlet delta (°C)
    "oilDilutionPct",          # Fuel-in-oil estimate (%) — PACCAR/Cummins
    "coolantPressureDecay",    # Pressure loss at key-off (kPa/min)
    "turboBearingTemp",        # Turbo bearing temperature (°C) — Detroit/Cummins
    "dpfAshLoad",              # DPF ash accumulation model output (%)
    "scrEfficiency",           # SCR catalyst conversion efficiency (%)

    # ── Physical sensors / Tier 3 hardware ───────────────────────────────────
    "hubTempFL",               # Wheel hub temp front-left (°C)
    "hubTempFR",               # Wheel hub temp front-right (°C)
    "hubTempRL",               # Wheel hub temp rear-left (°C)
    "hubTempRR",               # Wheel hub temp rear-right (°C)
    "diffTempFront",           # Front differential oil temp (°C)
    "diffTempRear",            # Rear differential oil temp (°C)
    "airPressureCurrent",      # Air brake system pressure (kPa)
    "airPressureDecayRate",    # Pressure decay at key-off (kPa/min)

    # ── Accelerometer — FFT-derived (Tier 2/3 hardware) ──────────────────────
    "accelXRms",               # X-axis RMS amplitude (g)
    "accelYRms",               # Y-axis RMS amplitude (g)
    "accelZRms",               # Z-axis RMS amplitude (g)
    "bearingFreqScore",        # Energy in wheel bearing frequency bands (0-1)
    "drivetrainFreqScore",     # Energy at driveshaft harmonics (0-1)
    "engineMountScore",        # Low-frequency idle vibration score (0-1)
    "vibrationAsymmetry",      # Z vs XY ratio — imbalance signature
]

# Derived hub-temp signals computed at extraction time (not raw sensor keys)
from .feature_contract import SENSOR_FEATURES
METRIC_KEYS = list(dict.fromkeys([*METRIC_KEYS, *SENSOR_FEATURES.values()]))
_HUB_TEMP_KEYS = ["hubTempFL", "hubTempFR", "hubTempRL", "hubTempRR"]

WINDOW_HOURS = [24, 168, 720]  # 1d, 7d, 30d


def _to_f(v) -> Optional[float]:
    if v is None or v == "" or isinstance(v, bool):
        return None
    try:
        n = float(v)
        return n if math.isfinite(n) else None
    except (TypeError, ValueError):
        return None


_VALID_RANGES = {
    "batteryVoltage": (5.0, 40.0),
    "rpm": (0.0, 10000.0),
    "vehicleSpeed": (0.0, 300.0),
    "coolantTemp": (-50.0, 150.0),
    "oilTemp": (-50.0, 200.0),
    "engineLoad": (0.0, 110.0),
    "fuelLevel": (0.0, 100.0),
    "throttlePos": (0.0, 100.0),
    "dpfSootLoad": (0.0, 100.0),
}


def metric_value(sample: dict, metric_key: str) -> Optional[float]:
    metrics = sample.get("metrics") if isinstance(sample.get("metrics"), dict) else {}
    value = _to_f(metrics.get(metric_key))
    # Explicit unit fields take precedence over ambiguous legacy names. Fuel
    # and oil models use psi; tire-pressure training observations use kPa.
    aliases = {"fuelPressure": ("fuelPressureKpa", 1 / 6.894757293),
               "oilPressure": ("oilPressureKpa", 1 / 6.894757293),
               "tirePressure": ("tirePressureKpa", 1),
               "transmissionTemp": ("transmissionTempC", 1)}
    alias, scale = aliases.get(metric_key, ("", 1))
    if alias in metrics:
        observed = _to_f(metrics.get(alias))
        value = observed * scale if observed is not None else None
    elif metric_key == "fuelPressure" and value is not None:
        # Historical exports renamed raw kPa to fuelPressure. Convert only
        # when raw evidence agrees; never revive a nulled/stale measurement.
        raw = sample.get("raw") if isinstance(sample.get("raw"), dict) else {}
        raw_kpa = _to_f(raw.get("fuelPressureKpa"))
        if raw_kpa is not None and math.isclose(value, raw_kpa, abs_tol=1e-8):
            value = raw_kpa / 6.894757293
    limits = _VALID_RANGES.get(metric_key)
    if value is None or limits is None:
        return value
    return value if limits[0] <= value <= limits[1] else None


def coalesce_samples(samples: list[dict], bucket_seconds: int = 5) -> list[dict]:
    """Merge burst uploads into one richer physical observation per time bucket."""
    if bucket_seconds <= 0:
        raise ValueError("Observation bucket must be positive")
    unique = {}
    ordered = [(parsed, sample) for sample in samples
               if (parsed := _parse_ts(sample.get("ts") or sample.get("timestamp"))) is not None]
    for parsed, sample in sorted(ordered, key=lambda entry: entry[0]):
        timestamp = parsed.astimezone(timezone.utc).isoformat()
        bucket = int(parsed.timestamp() // bucket_seconds)
        vehicle_id = str(sample.get("vehicleId") or "").strip()
        metrics = dict(sample.get("metrics")) if isinstance(sample.get("metrics"), dict) else {}
        # Resolve ambiguous units before merging frames, while each value still
        # has its own raw provenance. Explicit aliases stay mutually consistent.
        for field, alias, scale in [("fuelPressure", "fuelPressureKpa", 6.894757293),
                                    ("oilPressure", "oilPressureKpa", 6.894757293),
                                    ("tirePressure", "tirePressureKpa", 1),
                                    ("transmissionTemp", "transmissionTempC", 1)]:
            if field in metrics or alias in metrics:
                value = metric_value(sample, field)
                metrics[field] = value
                metrics[alias] = value * scale if value is not None else None
        key = (sample.get("orgId"), vehicle_id, bucket)
        existing = unique.get(key)
        if existing is None:
            unique[key] = {**sample, "ts": timestamp, "metrics": metrics}
            continue
        merged_metrics = dict(existing.get("metrics") or {})
        merged_metrics.update({k: v for k, v in metrics.items() if v is not None and v != ""})
        existing_ts = str(existing.get("ts") or existing.get("timestamp") or "")
        unique[key] = {
            **existing,
            **sample,
            "ts": max(existing_ts, timestamp),
            "metrics": merged_metrics,
        }
    return list(unique.values())


def _parse_ts(ts_str) -> Optional[datetime]:
    if not ts_str:
        return None
    try:
        ts = ts_str if isinstance(ts_str, datetime) else datetime.fromisoformat(str(ts_str).replace("Z", "+00:00"))
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        return ts
    except Exception:
        return None


def _window_samples(samples: list[dict], now_ts: datetime, hours: int) -> list[dict]:
    cutoff_ms = now_ts.timestamp() - hours * 3600
    return [s for s in samples if _parse_ts(s.get("ts")) and cutoff_ms <= _parse_ts(s.get("ts")).timestamp() <= now_ts.timestamp()]


def _stats(values: list[float]) -> dict:
    """Compute mean, std, min, max, slope from a list of values."""
    if not values:
        return {"mean": None, "std": None, "min": None, "max": None, "slope": None, "count": 0}
    n = len(values)
    mean = sum(values) / n
    var = sum((v - mean) ** 2 for v in values) / max(n - 1, 1)
    std = math.sqrt(var)
    # Linear slope via least squares
    if n >= 2:
        x_mean = (n - 1) / 2
        xy = sum(i * v for i, v in enumerate(values))
        xx = sum(i * i for i in range(n))
        slope = (xy - n * x_mean * mean) / max(xx - n * x_mean ** 2, 1e-9)
    else:
        slope = 0.0
    return {
        "mean": round(mean, 4),
        "std": round(std, 4),
        "min": round(min(values), 4),
        "max": round(max(values), 4),
        "slope": round(slope, 6),
        "count": n,
    }


# Phase 2B: Signals for which temporal acceleration features are computed.
# Only the highest-importance signals to avoid feature explosion.
from .feature_contract import TEMPORAL_KEYS, temporal_acceleration, elapsed_delta
_TEMPORAL_SLOPE_KEYS = TEMPORAL_KEYS


def _temporal_acceleration(values: list[float]) -> Optional[float]:
    """
    Phase 2B: Second derivative (acceleration) of a signal over a window.

    For evenly-spaced samples indexed 0..n-1, the centered quadratic coefficient a2
    satisfies: a2 = sum(xi^2 * yi) / sum(xi^4), where xi = i - (n-1)/2.
    (Odd moments vanish by symmetry, decoupling the 2nd-order term cleanly.)

    Returns 2*a2 (the second derivative of the fitted polynomial), or None if
    fewer than 6 values.  Units: value/sample².
    """
    n = len(values)
    if n < 6:
        return None
    center = (n - 1) / 2.0
    v_mean = sum(values) / n
    s_xx_y = 0.0  # Σ xi² (yi - ȳ)
    s_xxxx = 0.0  # Σ xi⁴
    s_xx   = 0.0  # Σ xi²
    for i, v in enumerate(values):
        xi = i - center
        xi2 = xi * xi
        s_xx_y += xi2 * (v - v_mean)
        s_xxxx += xi2 * xi2
        s_xx   += xi2
    # Correct denominator from 3-equation normal system: Σx⁴ - (Σx²)²/n
    denom = s_xxxx - (s_xx * s_xx) / n
    if denom < 1e-12:
        return None
    a2 = s_xx_y / denom
    return round(float(2.0 * a2), 8)


def _snake_to_camel(s: str) -> str:
    parts = s.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def _season_from_ts(ts: datetime) -> int:
    """0=spring, 1=summer, 2=fall, 3=winter"""
    m = ts.month
    if m in (3, 4, 5):
        return 0
    if m in (6, 7, 8):
        return 1
    if m in (9, 10, 11):
        return 2
    return 3


def _duty_cycle_score(samples: list[dict]) -> float:
    """Fraction of time RPM > 2000 or engineLoad > 70 — proxy for hard use."""
    if not samples:
        return 0.0
    hard_use = 0
    for s in samples:
        rpm = metric_value(s, "rpm")
        load = metric_value(s, "engineLoad")
        if (rpm and rpm > 2000) or (load and load > 70):
            hard_use += 1
    return round(hard_use / len(samples), 3)


def _sample_density(samples: list[dict]) -> float:
    """Average samples per hour over the observation window."""
    if len(samples) < 2:
        return 0.0
    ts_list = [_parse_ts(s.get("ts")) for s in samples]
    ts_list = [t for t in ts_list if t]
    if len(ts_list) < 2:
        return 0.0
    span_hours = (max(ts_list) - min(ts_list)).total_seconds() / 3600
    if span_hours < 0.01:
        return 0.0
    return round(len(ts_list) / span_hours, 2)


def _multivariate_stress(values_by_metric: dict[str, list[float]]) -> dict:
    """
    Detect simultaneous deviation in correlated metric groups.
    Returns a dict of subsystem -> stress_score (0-1).
    """
    results = {}
    # Cooling stress: coolantTemp rising + engineLoad high + rpm elevated
    cooling_vals = values_by_metric.get("coolantTemp", [])
    load_vals = values_by_metric.get("engineLoad", [])
    if cooling_vals and load_vals:
        c_recent = cooling_vals[-min(20, len(cooling_vals)):]
        l_recent = load_vals[-min(20, len(load_vals)):]
        c_slope = (_stats(c_recent)["slope"] or 0) / max(abs(_stats(c_recent)["mean"] or 1), 1)
        l_mean = (_stats(l_recent)["mean"] or 0) / 100
        results["cooling"] = round(min(1.0, abs(c_slope) * 10 + l_mean * 0.5), 3)

    # Charging stress: batteryVoltage dropping
    batt_vals = values_by_metric.get("batteryVoltage", [])
    if batt_vals:
        b_recent = batt_vals[-min(20, len(batt_vals)):]
        b_slope = _stats(b_recent)["slope"] or 0
        results["charging"] = round(min(1.0, max(0, -b_slope * 100)), 3)

    # Fuel stress: fuelRate diverging from baseline + MAF anomaly
    fuel_vals = values_by_metric.get("fuelRate", [])
    maf_vals = values_by_metric.get("maf", [])
    if fuel_vals and maf_vals:
        f_std = _stats(fuel_vals)["std"] or 0
        f_mean = abs(_stats(fuel_vals)["mean"] or 1)
        results["fuel"] = round(min(1.0, f_std / max(f_mean, 0.1)), 3)

    # Hub bearing stress: any hub temp > 80°C or delta > 20°C across wheels
    hub_vals = [values_by_metric.get(k, []) for k in _HUB_TEMP_KEYS]
    hub_current = [v[-1] for v in hub_vals if v]
    if hub_current:
        max_temp  = max(hub_current)
        temp_delta = max(hub_current) - min(hub_current)
        hub_score = min(1.0, max(
            max(0.0, (max_temp - 70.0) / 50.0),   # scale 70-120°C → 0-1
            min(1.0, temp_delta / 25.0),            # imbalance: 25°C delta = 1.0
        ))
        results["hub_bearing"] = round(hub_score, 3)

    # Drivetrain stress: vibration scores + driveshaft freq
    bearing_vals = values_by_metric.get("bearingFreqScore", [])
    drive_vals   = values_by_metric.get("drivetrainFreqScore", [])
    if bearing_vals or drive_vals:
        b_mean = (_stats(bearing_vals)["mean"] or 0) if bearing_vals else 0
        d_mean = (_stats(drive_vals)["mean"]   or 0) if drive_vals   else 0
        results["drivetrain_vibration"] = round(min(1.0, (b_mean + d_mean) / 2 * 2.5), 3)

    # Air brake stress: pressure decay rate elevated
    decay_vals = values_by_metric.get("airPressureDecayRate", [])
    if decay_vals:
        decay_mean = abs(_stats(decay_vals)["mean"] or 0)
        results["air_brake"] = round(min(1.0, decay_mean / 5.0), 3)  # 5 kPa/min = critical

    # Injector/fuel delivery stress: misfire + injector variance
    misfire_vals  = values_by_metric.get("cylinderMisfireCount", [])
    inj_bal_vals  = values_by_metric.get("injectorBalanceVariance", [])
    if misfire_vals or inj_bal_vals:
        m_score = min(1.0, (_stats(misfire_vals)["mean"] or 0) / 50) if misfire_vals else 0
        i_score = min(1.0, (_stats(inj_bal_vals)["mean"] or 0) / 10) if inj_bal_vals else 0
        results["fuel_delivery"] = round(max(m_score, i_score), 3)

    return results


def extract_features(samples: list[dict], vehicle_meta: Optional[dict] = None, lag_samples: Optional[list[dict]] = None) -> dict:
    """
    Extract a rich feature vector from telemetry samples.

    Args:
        samples: List of telemetry sample dicts with 'ts' and 'metrics' fields.
        vehicle_meta: Optional vehicle capability/metadata dict.

    Returns:
        feature_vector dict suitable for ML model input.
    """
    if not samples:
        return {"available": False, "sample_count": 0}

    # Sort oldest-first
    def safe_ts(s):
        t = _parse_ts(s.get("ts"))
        return t.timestamp() if t else 0
    samples = [s for s in samples if _parse_ts(s.get("ts")) is not None]
    if not samples:
        return {"available": False}
    sorted_samples = sorted(samples, key=safe_ts)
    latest = sorted_samples[-1]
    now_ts = _parse_ts(latest.get("ts")) or datetime.now(timezone.utc)

    # Per-metric values in each window
    window_stats: dict[str, dict] = {}
    all_metric_values: dict[str, list[float]] = {}

    for key in METRIC_KEYS:
        all_vals = [metric_value(s, key) for s in sorted_samples]
        all_vals = [v for v in all_vals if v is not None]
        all_metric_values[key] = all_vals
        from .feature_contract import temporal_slope
        def observed_stats(observations):
            values = [metric_value(s, key) for s in observations]
            result = _stats([v for v in values if v is not None])
            result["legacy_sample_slope"] = result["slope"]
            result["slope"] = temporal_slope([(s.get("ts"), metric_value(s, key)) for s in observations])
            result["slopeUnit"] = "sensor_unit/hour"
            return result
        key_stats = {"all": observed_stats(sorted_samples)}
        for h in WINDOW_HOURS:
            w_samples = _window_samples(sorted_samples, now_ts, h)
            w_vals = [metric_value(s, key) for s in w_samples]
            w_vals = [v for v in w_vals if v is not None]
            key_stats[f"h{h}"] = observed_stats(w_samples)
        window_stats[key] = key_stats

    # Current values from latest sample
    current_metrics = {k: metric_value(latest, k) for k in METRIC_KEYS}

    # Derived trend/anomaly signals Stage 2 (stage2.py) reads by these exact
    # names — training (fleet_simulation.py) has these as physics-modeled
    # synthetic columns; these are the real-telemetry equivalents computed
    # from the same rolling window_stats every other feature here uses.
    coolant_h24 = window_stats.get("coolantTemp", {}).get("h24", {})
    coolant_h720 = window_stats.get("coolantTemp", {}).get("h720", {})  # 720h = 30 days
    current_metrics["coolantTempOscillation"] = coolant_h24.get("std")
    current_metrics["engineTempDelta30d"] = elapsed_delta(
        [(s.get("ts"), metric_value(s, "coolantTemp")) for s in [*(lag_samples or []), *sorted_samples]], now_ts)
    # idle_heat_soak has no real-telemetry equivalent yet — nothing in
    # window_stats/METRIC_KEYS tracks idle duration or idle-specific heat
    # buildup (duty_cycle_score below measures hard-use time, not idle time).
    # Left missing (Stage 2 receives NaN), not a fabricated zero heat-soak value.

    # Duty cycle and density
    duty_cycle = _duty_cycle_score(sorted_samples[-500:] if len(sorted_samples) > 500 else sorted_samples)
    sample_density = _sample_density(sorted_samples)

    # Season
    season = _season_from_ts(now_ts)

    # Flat feature vector — initialized early so derived fields can populate it directly
    flat: dict[str, Optional[float]] = {}

    # Derived hub-temp signals (max across 4 wheels, imbalance delta)
    hub_temps = [current_metrics.get(k) for k in _HUB_TEMP_KEYS if current_metrics.get(k) is not None]
    if hub_temps:
        current_metrics["hubTempMax"]   = round(max(hub_temps), 2)
        current_metrics["hubTempDelta"] = round(max(hub_temps) - min(hub_temps), 2)
        flat["hubTempMax"]   = current_metrics["hubTempMax"]
        flat["hubTempDelta"] = current_metrics["hubTempDelta"]
    else:
        current_metrics["hubTempMax"]   = None
        current_metrics["hubTempDelta"] = None

    # Accelerometer FFT features (only computed if accel data present in samples)
    from .accelerometer import accel_from_samples
    speed = current_metrics.get("vehicleSpeed")
    accel_rpm = current_metrics.get("rpm")
    accel_feats = accel_from_samples(sorted_samples, vehicle_speed_kph=speed, rpm=accel_rpm)
    for k, v in accel_feats.items():
        # Map snake_case accel keys to camelCase metric keys
        camel = _snake_to_camel(k)
        current_metrics[camel] = v
        flat[camel] = v

    # Multivariate stress
    mv_stress = _multivariate_stress(all_metric_values)

    # Flat feature vector for ML models (numeric only) — populate remaining per-metric stats
    for key in METRIC_KEYS:
        st = window_stats[key]
        flat[f"{key}_mean_all"] = st["all"]["mean"]
        flat[f"{key}_std_all"] = st["all"]["std"]
        flat[f"{key}_slope_all"] = st["all"]["slope"]
        flat[f"{key}_mean_h24"] = st["h24"]["mean"]
        flat[f"{key}_slope_h24"] = st["h24"]["slope"]
        flat[f"{key}_current"] = current_metrics.get(key)

    flat["duty_cycle"] = duty_cycle
    flat["sample_density"] = sample_density
    flat["season"] = float(season)
    flat["cooling_stress"] = mv_stress.get("cooling", 0.0)
    flat["charging_stress"] = mv_stress.get("charging", 0.0)
    flat["fuel_stress"] = mv_stress.get("fuel", 0.0)
    flat["sample_count"] = float(len(sorted_samples))

    # Phase 2B: temporal acceleration features for key signals
    for tkey in _TEMPORAL_SLOPE_KEYS:
        points = [(s.get("ts"), metric_value(s, tkey))
                  for s in _window_samples(sorted_samples, now_ts, 24)]
        flat[f"{tkey}_accel_h24"] = temporal_acceleration(points, now_ts)

    from .feature_contract import DELTA_FEATURES
    for feature, metric in DELTA_FEATURES.items():
        flat[feature] = elapsed_delta(
            [(s.get("ts"), metric_value(s, metric)) for s in [*(lag_samples or []), *sorted_samples]], now_ts)

    # Vehicle meta
    if vehicle_meta:
        year = vehicle_meta.get("year")
        if year:
            flat["vehicle_age_years"] = float(max(0, 2026 - int(year)))

    return {
        "available": True,
        "sample_count": len(sorted_samples),
        "window_stats": window_stats,
        "current_metrics": current_metrics,
        "duty_cycle": duty_cycle,
        "sample_density": sample_density,
        "season": season,
        "multivariate_stress": mv_stress,
        "flat": flat,
    }


def build_numpy_feature_row(flat: dict[str, Optional[float]], feature_keys: list[str]):
    """Convert flat dict to numpy array in a consistent column order."""
    import numpy as np
    row = []
    for k in feature_keys:
        v = flat.get(k)
        row.append(float(v) if v is not None else float("nan"))
    return np.array(row, dtype=np.float32)
