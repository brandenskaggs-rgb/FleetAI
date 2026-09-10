"""Versioned feature contract shared by offline training and both Python services.

Unknown observations remain NaN in model matrices and null in JSON evidence.
Only a fitted, artifact-bound imputer may replace them. Physics estimates are
distinct from measurements; their assumptions must accompany the prediction.
"""
from __future__ import annotations

import hashlib
import json
import math
from functools import lru_cache
from datetime import datetime, timezone

SCHEMA_VERSION = "fleet-features-v5-time-aware"
PHYSICS_VERSION = "physics-v4.4"
PRETRAINED_FEATURES = """
vehicle_class_code protocol_code make_code powertrain_code model_year odometer_miles engine_hours
drive_cycle_phase_code time_since_start_min rpm engine_temp oil_temp transmission_temp fuel_pressure
fuel_rate battery_voltage vibration dpf_soot_load brake_temp tire_pressure ambient_temp_c elevation_ft
payload_ratio road_grade_pct idle_hours_day stop_go_ratio long_haul_ratio towing_ratio maintenance_neglect
sensor_missing_rate engine_temp_delta_30d fuel_pressure_delta_30d battery_voltage_delta_30d
vibration_delta_30d dpf_soot_delta_30d brake_temp_delta_30d egr_flow_rate coolant_oil_delta
maf_throttle_ratio intake_ambient_delta dpf_differential_kpa oil_pressure fuel_trim_short fuel_trim_long
idle_heat_soak throttle_lag_score turbo_boost_kpa exhaust_back_pressure engine_efficiency
rpm_variance_load_adj coolant_temp_oscillation air_density_kg_m3 aero_drag_kw rolling_resistance_kw
road_load_kw volumetric_efficiency_pct bsfc_g_per_kwh charge_density_ratio egt_c turbo_outlet_temp_c
scr_inlet_temp_c def_consumption_rate_pct thermal_lag heat_soak_delta_c egr_cooler_fouling
oil_viscosity_cst lubrication_regime_index oil_tbn bearing_wear_index bearing_spall_stage
hub_temp_fl_c hub_temp_fr_c hub_temp_rl_c hub_temp_rr_c dpf_ash_pct dpf_in_regen battery_soh_pct
battery_soc_pct alternator_deficit_w cranking_voltage_v sensor_coolant_error_c sensor_maf_error_pct
sensor_o2_lag_ms hubTempFL_accel_h24 hubTempFR_accel_h24 hubTempRL_accel_h24 hubTempRR_accel_h24
coolantTemp_accel_h24 oilTemp_accel_h24 batteryVoltage_accel_h24 dpfSootLoad_accel_h24
bearingFreqScore_accel_h24 turboBearingTemp_accel_h24
""".split()
STAGE2_FEATURES = """
stage1_score pretrained_score if_score welford_score threshold_score dtc_score
w_pretrained w_if w_welford w_threshold w_dtc signal_agreement fleet_percentile mv_stress_max
sample_count welford_confidence pretrained_decayed has_cooling_dtc has_fuel_dtc has_electrical_dtc
has_emissions_dtc has_engine_dtc diagnosis_urgency vehicle_class_code ambient_temp idle_heat_soak
coolant_temp_oscillation battery_voltage engine_temp_delta_30d
""".split()
STAGE2_CLASS_CODES = {"passenger_car": 0, "light_duty_truck": 1, "cargo_van": 2,
                      "medium_duty": 3, "heavy_duty_j1939": 4}
TEMPORAL_KEYS = [f.removesuffix("_accel_h24") for f in PRETRAINED_FEATURES if f.endswith("_accel_h24")]
SENSOR_FEATURES = {
    "rpm": "rpm", "engine_temp": "coolantTemp", "oil_temp": "oilTemp",
    "transmission_temp": "transmissionTemp", "fuel_pressure": "fuelPressure",
    "fuel_rate": "fuelRate", "battery_voltage": "batteryVoltage", "vibration": "vibration",
    "dpf_soot_load": "dpfSootLoad", "brake_temp": "brakeTemp", "tire_pressure": "tirePressure",
    "ambient_temp_c": "ambientTemp", "oil_pressure": "oilPressure",
    "fuel_trim_short": "fuelTrimShort", "fuel_trim_long": "fuelTrimLong",
    "egr_flow_rate": "egrFlowRate", "dpf_differential_kpa": "dpfDifferentialPressure",
}
DELTA_FEATURES = {
    "engine_temp_delta_30d": "coolantTemp", "fuel_pressure_delta_30d": "fuelPressure",
    "battery_voltage_delta_30d": "batteryVoltage", "vibration_delta_30d": "vibration",
    "dpf_soot_delta_30d": "dpfSootLoad", "brake_temp_delta_30d": "brakeTemp",
}


def finite(value):
    if value is None or value == "" or isinstance(value, bool):
        return None
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):
        return None


def epoch(value):
    try:
        parsed = value if isinstance(value, datetime) else datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc).timestamp() if parsed.tzinfo is None else parsed.timestamp()
    except (TypeError, ValueError, OverflowError):
        return None


def temporal_acceleration(points, now=None):
    """Quadratic least-squares second derivative, sensor units/hour squared.

    At least six distinct observed timestamps within the preceding 24 hours.
    No interpolation, no future values, no assumed sampling frequency.
    """
    import numpy as np
    observed = {epoch(t): finite(v) for t, v in points}
    observed = {t: v for t, v in observed.items() if t is not None and v is not None}
    end = epoch(now) if now is not None else max(observed, default=None)
    if end is None:
        return None
    ordered = sorted((t, v) for t, v in observed.items() if end - 86400 <= t <= end)
    if len(ordered) < 6 or ordered[-1][0] <= ordered[0][0]:
        return None
    x = np.array([(t - end) / 3600 for t, _ in ordered])
    y = np.array([v for _, v in ordered])
    design = np.column_stack([x*x, x, np.ones(len(x))])
    coeff, _, rank, _ = np.linalg.lstsq(design, y, rcond=None)
    return float(2 * coeff[0]) if rank == 3 else None


def temporal_slope(points):
    observed = sorted((epoch(t), finite(v)) for t, v in points if epoch(t) is not None and finite(v) is not None)
    if len(observed) < 2 or observed[0][0] == observed[-1][0]:
        return None
    x = [(t - observed[0][0]) / 3600 for t, _ in observed]
    y = [v for _, v in observed]
    xm, ym = sum(x)/len(x), sum(y)/len(y)
    return sum((a-xm)*(b-ym) for a,b in zip(x,y)) / sum((a-xm)**2 for a in x)


def elapsed_delta(points, now, days=30, tolerance_hours=24):
    """Current minus an observed value at/before the elapsed-time boundary.

    The lag observation must be no more than tolerance_hours older than the
    boundary. Missing/short history stays missing, rather than a zero delta.
    """
    end = epoch(now)
    if end is None:
        return None
    data = sorted((epoch(t), finite(v)) for t, v in points if epoch(t) is not None and finite(v) is not None)
    current = [v for t, v in data if t == end]
    target = end - days * 86400
    past = [v for t, v in data if target - tolerance_hours * 3600 <= t <= target]
    return current[-1] - past[-1] if current and past else None


@lru_cache(maxsize=1)
def implementation_digest():
    """Bind artifacts to the actual transforms, not just a hand-edited version."""
    import ast
    from pathlib import Path
    from importlib.util import find_spec
    selected = {
        "feature_contract.py": {"finite", "epoch", "temporal_acceleration", "temporal_slope", "elapsed_delta", "time_features"},
        "features.py": {"metric_value", "extract_features", "_stats", "_multivariate_stress"},
        "pretrained.py": {"_build_row", "build_input"},
        "stage2.py": {"build_features"},
    }
    pieces = []
    for filename, names in selected.items():
        tree = ast.parse(Path(__file__).with_name(filename).read_text(encoding="utf-8-sig"))
        pieces.extend(ast.dump(node, include_attributes=False) for node in tree.body
                      if isinstance(node, (ast.Assign, ast.AnnAssign)))
        pieces.extend(ast.dump(node, include_attributes=False) for node in ast.walk(tree)
                      if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names)
    spec = find_spec("fleet_ai.physics.vehicle_physics")
    if spec and spec.origin:
        pieces.append(ast.dump(ast.parse(Path(spec.origin).read_text(encoding="utf-8-sig")), include_attributes=False))
    return hashlib.sha256("\n".join(pieces).encode()).hexdigest()


def manifest(features=PRETRAINED_FEATURES):
    units = {name: "dimensionless_index" for name in features}
    groups = {
        "degC": "engine_temp oil_temp transmission_temp brake_temp ambient_temp ambient_temp_c coolant_oil_delta intake_ambient_delta egt_c turbo_outlet_temp_c scr_inlet_temp_c heat_soak_delta_c hub_temp_fl_c hub_temp_fr_c hub_temp_rl_c hub_temp_rr_c sensor_coolant_error_c coolant_temp_oscillation engine_temp_delta_30d brake_temp_delta_30d",
        "psi": "fuel_pressure oil_pressure fuel_pressure_delta_30d",
        "volt": "battery_voltage cranking_voltage_v battery_voltage_delta_30d",
        "kPa": "tire_pressure dpf_differential_kpa turbo_boost_kpa exhaust_back_pressure",
        "percent": "dpf_soot_load dpf_soot_delta_30d road_grade_pct fuel_trim_short fuel_trim_long volumetric_efficiency_pct def_consumption_rate_pct dpf_ash_pct battery_soh_pct battery_soc_pct sensor_maf_error_pct",
        "kW": "aero_drag_kw rolling_resistance_kw road_load_kw",
        "hour": "engine_hours", "hour/day": "idle_hours_day", "minute": "time_since_start_min",
        "mile": "odometer_miles", "foot": "elevation_ft", "rpm": "rpm",
        "liter/hour": "fuel_rate", "kg/m^3": "air_density_kg_m3",
        "g/kWh": "bsfc_g_per_kwh", "cSt": "oil_viscosity_cst", "mgKOH/g": "oil_tbn",
        "watt": "alternator_deficit_w", "millisecond": "sensor_o2_lag_ms", "year": "model_year",
        "categorical_code": "vehicle_class_code protocol_code make_code powertrain_code drive_cycle_phase_code bearing_spall_stage",
    }
    for unit, names in groups.items():
        for name in names.split():
            if name in units:
                units[name] = unit
    for name in features:
        if name.endswith("_accel_h24"):
            units[name] = "volt/hour^2" if name.startswith("batteryVoltage") else "percent/hour^2" if name.startswith("dpfSootLoad") else "index/hour^2" if name.startswith("bearingFreqScore") else "degC/hour^2"
    result = {"version": SCHEMA_VERSION, "features": list(features),
              "implementationSha256": implementation_digest(),
              "units": units,
              "temporalAccelerationUnits": "sensor_unit/hour^2", "delta30d": "observed_asof_30_days_tolerance_24h",
              "windowClock": "UTC_event_time_inclusive_no_future", "missing": "NaN_model_null_evidence",
              "physicsVersion": PHYSICS_VERSION}
    result["sha256"] = hashlib.sha256(json.dumps(result, sort_keys=True).encode()).hexdigest()
    return result


def validate_features(features, expected=PRETRAINED_FEATURES):
    if list(features) != list(expected):
        raise ValueError("Model feature names/order do not match the canonical contract")


def validate_bundle_schema(bundle, expected=PRETRAINED_FEATURES):
    validate_features(bundle.get("features", []), expected)
    schema = bundle.get("feature_schema") or bundle.get("metadata", {}).get("featureSchema")
    if schema is not None and schema != manifest(expected):
        raise ValueError("Artifact feature definitions/units/version require revalidation")
    return "canonical" if schema else "legacy_unversioned"


def vector(row, features):
    return [finite(row.get(name)) if finite(row.get(name)) is not None else float("nan") for name in features]


def json_safe(value):
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def supervised_label(outcome):
    # No observation, "unknown", or mere absence of alerts is a negative label.
    return {"confirmed_breakdown": 1, "false_positive": 0, "confirmed_normal": 0}.get(outcome)


def time_features(frame, group_col, time_col, mapping):
    """Build the same timestamp-based features used by inference for a frame.

    mapping maps canonical sensor names to input columns. Group boundaries are
    never crossed. Duplicate observation times are rejected as ambiguous.
    """
    import pandas as pd
    result = frame.copy()
    result[time_col] = pd.to_datetime(result[time_col], utc=True, errors="raise")
    if result.duplicated([group_col, time_col]).any():
        raise ValueError("Duplicate vehicle timestamps in training history")
    result = result.sort_values([group_col, time_col])
    names = [*(f"{k}_accel_h24" for k in TEMPORAL_KEYS), *DELTA_FEATURES]
    for name in names:
        result[name] = float("nan")
    for _, group in result.groupby(group_col, sort=False):
        for key in TEMPORAL_KEYS:
            col = mapping.get(key)
            if col not in group.columns:
                continue
            series = group.set_index(time_col)[col]
            values = series.rolling("24h", min_periods=6, closed="both").apply(
                lambda w: temporal_acceleration(list(w.items()), w.index[-1]), raw=False)
            result.loc[group.index, f"{key}_accel_h24"] = values.to_numpy()
        for feature, key in DELTA_FEATURES.items():
            col = mapping.get(key)
            if col not in group.columns:
                continue
            current = group[[time_col, col]].sort_values(time_col)
            past = current.dropna(subset=[col]).rename(columns={time_col: "lag_time", col: "lag_value"})
            query = current.copy()
            query["boundary"] = query[time_col] - pd.Timedelta(days=30)
            joined = pd.merge_asof(query, past, left_on="boundary", right_on="lag_time",
                                   tolerance=pd.Timedelta(hours=24), direction="backward")
            result.loc[group.index, feature] = (joined[col] - joined["lag_value"]).to_numpy()
    return result
