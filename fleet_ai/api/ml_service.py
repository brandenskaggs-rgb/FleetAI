"""Fleet AI Python ML service.

Primary inference path for pretrained synthetic priors. The Node backend calls
this service and falls back to deterministic JavaScript scoring if unavailable.
"""

from __future__ import annotations

import json
import math
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import joblib
import pandas as pd
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field


# Per-class physics specs — kept in sync with fleet_simulation.py _PHYS table.
_VC_CODES: dict[str, int] = {
    "heavy_duty_j1939": 0, "heavy_duty": 0, "heavy": 0,
    "medium_duty": 1, "medium": 1,
    "light_duty_truck": 2, "light_duty": 2, "light": 2,
    "cargo_van": 3, "van": 3,
    "passenger_car": 4, "car": 4, "passenger": 4,
}
_PHYS_SPECS: dict[int, dict] = {
    0: {"mass": 36000, "A": 9.4,  "Cd": 0.60, "Crr": 0.0065, "eng_kw": 450, "alt_kw": 3.5, "dpf": True},
    1: {"mass": 12000, "A": 6.8,  "Cd": 0.65, "Crr": 0.0070, "eng_kw": 200, "alt_kw": 2.2, "dpf": True},
    2: {"mass":  3800, "A": 3.3,  "Cd": 0.45, "Crr": 0.0080, "eng_kw": 290, "alt_kw": 1.4, "dpf": False},
    3: {"mass":  4500, "A": 4.2,  "Cd": 0.52, "Crr": 0.0078, "eng_kw": 220, "alt_kw": 1.6, "dpf": False},
    4: {"mass":  1600, "A": 2.2,  "Cd": 0.30, "Crr": 0.0085, "eng_kw": 130, "alt_kw": 1.0, "dpf": False},
}


def _isa_density(altitude_ft: float, ambient_c: float) -> float:
    alt_m = altitude_ft * 0.3048
    T_k = max(200.0, ambient_c + 273.15)
    if alt_m < 11000:
        P_pa = 101325.0 * (1.0 - 2.2558e-5 * alt_m) ** 5.2559
    else:
        P_pa = 101325.0 * 0.22336 * math.exp(-1.5769e-4 * (alt_m - 11000))
    return max(0.5, P_pa / (287.058 * T_k))


def _walther_viscosity(oil_temp_c: float) -> float:
    T_k = max(243.0, min(473.0, oil_temp_c + 273.15))
    exponent = max(-2.0, min(3.0, 7.949 - 3.061 * math.log10(T_k)))
    return max(1.0, min(2000.0, 10.0 ** (10.0 ** exponent) - 0.7))


def _oil_film_ratio(viscosity_cst: float, rpm: float, engine_load_pct: float) -> float:
    eta = viscosity_cst * 1e-6  # kinematic viscosity in m²/s
    N = max(1.0, rpm) / 60.0
    P = max(0.01, engine_load_pct / 100.0)
    raw = (eta * N / P) ** 0.7
    nominal = (8e-6 * 25.0 / 0.6) ** 0.7
    return min(1.0, max(0.0, raw / nominal))


def _oil_tbn(engine_hours: float, oil_temp_c: float, maintenance_neglect: float) -> float:
    T_excess = max(0.0, oil_temp_c - 95.0)
    rate = 0.0025 * (2.0 ** (T_excess / 10.0)) * (1.0 + maintenance_neglect * 0.5)
    oil_change_interval = max(200.0, 300.0 * (1.0 - maintenance_neglect * 0.6))
    hrs_since_change = engine_hours % max(oil_change_interval, 50.0)
    return max(0.0, min(10.0, 10.0 * math.exp(-rate * hrs_since_change)))


def _bearing_wear(odometer_miles: float, engine_hours: float, vc_code: int,
                  payload_ratio: float, maintenance_neglect: float, engine_temp_c: float):
    bases = {0: 26000, 1: 17000, 2: 8000, 3: 9000, 4: 5000}
    service_mi = {0: 480000, 1: 300000, 2: 140000, 3: 160000, 4: 100000}
    avg_mph = {0: 38, 1: 32, 2: 27, 3: 27, 4: 31}
    l10_base = bases.get(vc_code, 13000)
    svc_mi = service_mi.get(vc_code, 200000)
    speed_mph = avg_mph.get(vc_code, 30)
    load_factor = max(0.4, min(1.3, 1.0 - (payload_ratio - 0.5) * 0.4))
    maint_factor = max(0.3, min(1.0, 1.0 - maintenance_neglect * 0.55))
    l10 = max(800.0, l10_base * load_factor * maint_factor)
    svc_interval_adj = max(40000.0, svc_mi * max(0.5, 1.0 + (1.0 - maintenance_neglect) * 0.25
                                                  - maintenance_neglect * 0.15))
    miles_since = odometer_miles % svc_interval_adj
    hrs_bearing = miles_since / max(speed_mph, 1.0)
    temp_factor = max(1.0, min(2.5, 1.0 + max(0.0, engine_temp_c - 95.0) * 0.025))
    wear_index = min(3.0, hrs_bearing / max(l10, 100.0) * temp_factor)
    if wear_index >= 1.20:
        stage = 3.0
    elif wear_index >= 0.80:
        stage = 2.0
    elif wear_index >= 0.45:
        stage = 1.0
    else:
        stage = 0.0
    return wear_index, stage


def _battery_soh(age_years: float, avg_temp_c: float, idle_hrs_day: float,
                 maintenance_neglect: float) -> float:
    batt_interval = max(2.0, min(6.0, 3.5 + (1.0 - maintenance_neglect) * 1.5))
    eff_age = age_years % batt_interval
    T_excess = max(0.0, avg_temp_c - 25.0)
    rate = 7.0 * (2.0 ** (T_excess / 10.0)) * (1.0 + idle_hrs_day * 0.06)
    return max(30.0, min(100.0, 100.0 - rate * eff_age))


def _cranking_voltage(battery_soh: float, ambient_c: float) -> float:
    soh_f = battery_soh / 100.0
    v_oc = 12.4 + 0.3 * soh_f
    T_k = max(233.0, ambient_c + 273.15)
    r_int = max(0.005, (0.012 * (1.0 - soh_f * 0.6)) * (298.0 / T_k) ** 1.5)
    return max(8.0, min(14.5, v_oc - 250 * r_int))


def _dpf_ash(engine_hours: float, vc_code: int, maintenance_neglect: float, is_diesel: bool) -> float:
    if not is_diesel:
        return 0.0
    ash_cap_g = {0: 5000.0, 1: 2500.0, 2: 1000.0, 3: 1000.0, 4: 500.0}
    cap = ash_cap_g.get(vc_code, 2500.0)
    return min(100.0, engine_hours * 0.50 * (1.0 + maintenance_neglect * 0.8) / cap * 100.0)


ROOT = Path(__file__).resolve().parents[1]
MODELS_DIR = ROOT / "models"
MODEL_PATH = MODELS_DIR / "fleet_ai_model.pkl"
METADATA_PATH = MODELS_DIR / "fleet_ai_model_metadata.json"
PROFILES_PATH = MODELS_DIR / "fleet_ai_baseline_profiles.json"

app = FastAPI(title="Fleet AI ML Service", version="2.0.0")


class VehicleMeta(BaseModel):
    vehicleId: Optional[str] = None
    vin: Optional[str] = None
    make: Optional[str] = None
    model: Optional[str] = None
    year: Optional[int] = None
    protocol: Optional[str] = None
    vehicleClass: Optional[str] = None
    powertrain: Optional[str] = None


class TelemetrySample(BaseModel):
    ts: Optional[str] = None
    metrics: Dict[str, Any] = Field(default_factory=dict)
    raw: Dict[str, Any] = Field(default_factory=dict)
    odometer: Optional[float] = None
    engineHours: Optional[float] = None


class PredictRequest(BaseModel):
    orgId: Optional[str] = None
    vehicleId: str
    vehicleMeta: VehicleMeta = Field(default_factory=VehicleMeta)
    samples: List[TelemetrySample] = Field(default_factory=list)
    alertMode: str = "launch_default"


MODEL: Optional[dict] = None
METADATA: dict = {}
PROFILES: dict = {}


def _load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def load_artifacts(force: bool = False) -> None:
    global MODEL, METADATA, PROFILES
    if MODEL is not None and not force:
        return
    if not MODEL_PATH.exists():
        MODEL = None
    else:
        loaded = joblib.load(MODEL_PATH)
        MODEL = loaded if isinstance(loaded, dict) else {"model": loaded, "model_type": "single", "threshold": 0.5}
    METADATA = _load_json(METADATA_PATH, {})
    profile_payload = _load_json(PROFILES_PATH, {"profiles": {}})
    PROFILES = profile_payload.get("profiles", profile_payload if isinstance(profile_payload, dict) else {})


def _norm(value: Any) -> str:
    return str(value or "").strip().lower().replace(" ", "_")


def infer_vehicle_class(meta: VehicleMeta) -> str:
    explicit = _norm(meta.vehicleClass)
    if explicit:
        return explicit
    protocol = str(meta.protocol or "").upper()
    make = _norm(meta.make)
    model = _norm(meta.model)
    if protocol == "J1939" or model in {"cascadia", "vnl", "579", "t680", "lt"}:
        return "heavy_duty_j1939"
    if model in {"m2", "f-650", "f650"}:
        return "medium_duty"
    if model in {"transit", "express", "promaster"}:
        return "cargo_van"
    if make in {"freightliner", "volvo", "peterbilt", "kenworth", "international"}:
        return "heavy_duty_j1939"
    if make in {"ford", "chevrolet", "ram"}:
        return "light_duty_truck"
    return "passenger_car"


def resolve_profile(meta: VehicleMeta) -> dict:
    load_artifacts()
    vehicle_class = infer_vehicle_class(meta)
    make = _norm(meta.make)
    model = _norm(meta.model)
    candidates = []
    if make and model:
        candidates.append(f"{vehicle_class}:{make}:{model}")
    if make:
        candidates.extend([key for key, profile in PROFILES.items() if _norm(profile.get("make")) == make and profile.get("vehicleClass") == vehicle_class])
    candidates.extend([key for key, profile in PROFILES.items() if profile.get("vehicleClass") == vehicle_class])
    candidates.extend(list(PROFILES.keys()))
    for key in candidates:
        profile = PROFILES.get(key)
        if profile:
            return profile
    return {
        "profileKey": "unknown",
        "vehicleClass": vehicle_class,
        "make": meta.make or "Unknown",
        "model": meta.model or "Unknown",
        "protocol": meta.protocol or ("J1939" if vehicle_class == "heavy_duty_j1939" else "OBD2"),
        "powertrain": meta.powertrain or ("diesel" if vehicle_class in {"heavy_duty_j1939", "medium_duty"} else "gasoline"),
        "trainingSource": "synthetic_prior_unmatched",
        "modelVersion": METADATA.get("modelVersion", "unknown"),
        "sampleCount": 0,
        "failureRate": 0.04,
        "baselineMetrics": {},
        "subsystemPriors": {},
    }


def _num(value: Any, default: Optional[float] = None) -> Optional[float]:
    try:
        if value is None or value == "":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def latest_metric(samples: List[TelemetrySample], names: List[str], default: Optional[float] = None) -> Optional[float]:
    for sample in reversed(samples):
        data = {**(sample.raw or {}), **(sample.metrics or {})}
        for name in names:
            val = _num(data.get(name))
            if val is not None:
                return val
    return default


def delta_from_profile(current: Optional[float], profile: dict, metric: str) -> float:
    mean = _num(profile.get("baselineMetrics", {}).get(metric, {}).get("mean"), 0.0)
    if current is None or mean is None:
        return 0.0
    return float(current - mean)


def feature_vector(req: PredictRequest, profile: dict) -> dict:
    samples = req.samples or []
    meta = req.vehicleMeta
    codes = MODEL or {}
    vehicle_class = profile.get("vehicleClass") or infer_vehicle_class(meta)
    protocol = profile.get("protocol") or meta.protocol or ("J1939" if vehicle_class == "heavy_duty_j1939" else "OBD2")
    powertrain = profile.get("powertrain") or meta.powertrain or ("diesel" if protocol == "J1939" else "gasoline")
    make = profile.get("make") or meta.make or "Unknown"
    is_diesel = powertrain.lower() in {"diesel", "j1939"}

    def _bm(key: str, default: float) -> float:
        return _num(profile.get("baselineMetrics", {}).get(key, {}).get("mean"), default) or default

    rpm = latest_metric(samples, ["rpm"], _bm("rpm", 1500))
    engine_temp = latest_metric(samples, ["engine_temp", "coolantTemp", "coolant_temp"], _bm("engine_temp", 94))
    oil_temp = latest_metric(samples, ["oil_temp", "oilTemp"], _bm("oil_temp", engine_temp or 98))
    transmission_temp = latest_metric(samples, ["transmission_temp", "transmissionTemp"], _bm("transmission_temp", 90))
    fuel_pressure = latest_metric(samples, ["fuel_pressure", "fuelRailPressure", "fuel_rail"], _bm("fuel_pressure", 52))
    fuel_rate = latest_metric(samples, ["fuel_rate", "fuelRate"], _bm("fuel_rate", 5))
    battery_voltage = latest_metric(samples, ["battery_voltage", "batteryVoltage"], _bm("battery_voltage", 13.8))
    vibration = latest_metric(samples, ["vibration", "vibrationG"], _bm("vibration", 0.4))
    dpf_soot = latest_metric(samples, ["dpf_soot_load", "dpfSootLoad"], _bm("dpf_soot_load", 20))
    brake_temp = latest_metric(samples, ["brake_temp", "brakeTemp"], _bm("brake_temp", 110))
    tire_pressure = latest_metric(samples, ["tire_pressure", "tpmsPressure"], _bm("tire_pressure", 250))
    ambient = latest_metric(samples, ["ambientTemp", "ambient_temp_c"], 20)
    elevation_ft = latest_metric(samples, ["elevation_ft", "elevation"], 1000)
    speed_kph = latest_metric(samples, ["vehicleSpeed", "speed_kph"], 60)
    throttle_pos = latest_metric(samples, ["throttlePos", "throttle_pos"], 25)
    maf_val = latest_metric(samples, ["maf", "massAirFlow"], None)
    intake_air_temp = latest_metric(samples, ["intakeAirTemp", "intake_air_temp"], None)
    map_kpa = latest_metric(samples, ["intakeManifoldPressure", "map_kpa"], None)
    time_since_start = latest_metric(samples, ["timeSinceStart", "time_since_start_min"], 45)

    latest_s = samples[-1] if samples else None
    odometer = _num(latest_s.odometer if latest_s else None, 50000)
    engine_hours = _num(latest_s.engineHours if latest_s else None, (odometer or 50000) / 32)
    payload_ratio = latest_metric(samples, ["payload_ratio", "payloadRatio"], 0.55)
    road_grade_pct = latest_metric(samples, ["road_grade_pct", "roadGradePct"], 1.0)
    idle_hours_day = latest_metric(samples, ["idle_hours_day", "idleHoursDay"], 1.0)
    maintenance_neglect = latest_metric(samples, ["maintenance_neglect", "maintenanceNeglect"], 0.18)

    vc_code = _VC_CODES.get(vehicle_class, 4)
    specs = _PHYS_SPECS.get(vc_code, _PHYS_SPECS[4])
    model_year = meta.year or 2020
    age_years = max(0.0, 2026.0 - model_year)

    # ── Drive cycle phase (infer from speed/rpm) ─────────────────────────────
    is_idle_state = speed_kph < 5 and rpm < 900
    is_highway = speed_kph > 80
    if is_idle_state:
        drive_phase = 0  # idle
    elif rpm < 1000 and time_since_start < 5:
        drive_phase = 1  # warmup
    elif is_highway:
        drive_phase = 3  # highway
    else:
        drive_phase = 2  # city

    # ── v4: atmosphere & aerodynamics ────────────────────────────────────────
    rho_sl = 1.225
    air_density = _isa_density(elevation_ft, ambient)
    v_ms = max(0.0, speed_kph / 3.6)
    F_drag = 0.5 * air_density * specs["Cd"] * specs["A"] * v_ms ** 2
    aero_drag_kw = F_drag * v_ms / 1000.0
    rolling_res_kw = specs["Crr"] * specs["mass"] * 9.81 * v_ms / 1000.0
    grade_force_kw = specs["mass"] * 9.81 * math.sin(math.atan(road_grade_pct / 100.0)) * v_ms / 1000.0
    road_load_kw = max(0.0, aero_drag_kw + rolling_res_kw + grade_force_kw)
    vol_eff_pct = min(100.0, max(30.0, air_density / rho_sl * 100.0))

    # ── v4: combustion ────────────────────────────────────────────────────────
    engine_load_pct = min(100.0, max(0.0, road_load_kw / max(specs["eng_kw"] * 0.01, 0.01)))
    rpm_ratio = (rpm - 1700.0) / 600.0
    load_ratio = (engine_load_pct - 72.0) / 30.0
    bsfc_base = 195.0 if is_diesel else 270.0
    bsfc_g_kwh = min(600.0, max(140.0, bsfc_base * math.exp(0.5 * (rpm_ratio ** 2 + load_ratio ** 2))))

    turbo_boost_kpa = 100.0
    if map_kpa is not None:
        turbo_boost_kpa = max(0.0, map_kpa - 101.325)

    # Lambda AFR — three independent signals (mirrors training _lambda())
    _load_f = min(1.0, max(0.05, engine_load_pct / 100.0))
    if is_diesel:
        _lambda_base = min(1.75, max(1.05, 1.75 - 0.80 * _load_f))
    elif _load_f > 0.80:
        _lambda_base = min(1.02, max(0.88, 1.02 - 0.30 * (_load_f - 0.80)))
    else:
        _lambda_base = min(1.02, max(0.96, 1.01 - 0.04 * _load_f))
    _pr = max(1.0, 1.0 + turbo_boost_kpa / 101.325)
    _boost_comp = min(0.45, max(0.0, (_pr - 1.0) * 0.35))
    _altitude_factor = min(1.05, max(0.55, min(1.10, max(0.50, vol_eff_pct / 100.0 + _boost_comp))))
    _nominal_rate = 0.185 if is_diesel else 0.200
    _ref_fuel = max(0.2, specs["eng_kw"] * _nominal_rate * _load_f)
    _fuel_ratio = min(2.50, max(0.50, fuel_rate / _ref_fuel))
    _fuel_factor = min(1.10, max(0.75, _fuel_ratio ** -0.25))
    lambda_afr = min(1.80, max(0.70, _lambda_base * _altitude_factor * _fuel_factor))

    egt_c_live = latest_metric(samples, ["egt", "exhaustGasTemp"], -1.0)
    if egt_c_live < 0:
        egt_c = max(150.0, min(850.0, 250.0 + 4.5 * engine_load_pct + 0.08 * rpm
                               + (50 if is_diesel else 0) - 1.5 * speed_kph * 0.05))
    else:
        egt_c = egt_c_live

    T1_k = max(250.0, ambient + 273.15)
    turbo_outlet_temp_c = T1_k * (1.0 + (_pr ** 0.2857 - 1.0) / 0.72) - 273.15
    scr_inlet_temp_c = max(100.0, egt_c - (80.0 + 0.4 * speed_kph))
    def_rate_pct = 0.0
    if is_diesel and scr_inlet_temp_c > 200.0:
        def_rate_pct = min(8.0, max(0.0, (scr_inlet_temp_c - 200.0) / 60.0 * 3.5))

    # ── v4: thermal ───────────────────────────────────────────────────────────
    therm_mass_factor = 1.0 if vc_code <= 1 else 0.5
    thermal_lag = math.exp(-time_since_start / max(1.0, 20.0 * therm_mass_factor))
    heat_soak_delta_c = max(0.0, 12.0 + egt_c * 0.04 - 5.0 * speed_kph / 80.0) if is_idle_state else 0.0
    egr_cooler_fouling = min(1.0, max(0.0, odometer / 800000.0 * (0.8 + maintenance_neglect * 0.4)))

    # ── v4: oil / lubrication ────────────────────────────────────────────────
    oil_viscosity_cst = _walther_viscosity(oil_temp)
    oil_film_ratio = _oil_film_ratio(oil_viscosity_cst, rpm, engine_load_pct)
    oil_tbn = _oil_tbn(engine_hours, oil_temp, maintenance_neglect)

    # ── v4: bearing & hub ────────────────────────────────────────────────────
    wear_index, spall_stage = _bearing_wear(odometer, engine_hours, vc_code,
                                            payload_ratio, maintenance_neglect, engine_temp)
    hub_fl = latest_metric(samples, ["hubTempFL", "hub_temp_fl_c"], -1.0)
    if hub_fl < 0:
        mu_est = 0.0015 + wear_index * 0.003
        h_conv = 8.0 + 0.22 * min(speed_kph, 130.0)
        omega = max(0.1, speed_kph / 3.6 / 3.2) * (2 * math.pi)
        load_n = specs["mass"] * max(0.10, 0.14 + payload_ratio * 0.06)
        Q_w = mu_est * load_n * omega * 0.065
        hub_est = min(200.0, ambient + Q_w / max(0.1, h_conv * 0.04))
        hub_fl = hub_fr = hub_rl = hub_rr = hub_est
    else:
        hub_fr = latest_metric(samples, ["hubTempFR", "hub_temp_fr_c"], hub_fl)
        hub_rl = latest_metric(samples, ["hubTempRL", "hub_temp_rl_c"], hub_fl)
        hub_rr = latest_metric(samples, ["hubTempRR", "hub_temp_rr_c"], hub_fl)

    # ── v4: DPF / emissions ──────────────────────────────────────────────────
    dpf_ash = _dpf_ash(engine_hours, vc_code, maintenance_neglect, is_diesel)
    dpf_regen = 1.0 if (is_diesel and dpf_soot >= 78.0) else 0.0

    # ── v4: battery / electrical ─────────────────────────────────────────────
    batt_soh = _battery_soh(age_years, ambient, idle_hours_day, maintenance_neglect)
    batt_soc = min(100.0, max(20.0, 95.0 - 15.0 * latest_metric(samples, ["stop_go_ratio", "stopGoRatio"], 0.3)))
    alt_output_w = min(specs["alt_kw"] * 1000.0, specs["alt_kw"] * 1000.0 * min(1.0, rpm / 1400.0))
    hvac_w = max(0.0, (abs(ambient - 22.0) / 15.0) * 1200.0)
    alt_deficit_w = max(-2000.0, min(2000.0, (hvac_w + 400.0) - alt_output_w))
    cranking_v = _cranking_voltage(batt_soh, ambient)

    # ── v4: sensor drift ─────────────────────────────────────────────────────
    coolant_error_c = max(0.0, min(8.0, odometer / 600000.0 * 4.0 * maintenance_neglect))
    maf_error_pct = max(0.0, min(15.0, odometer / 500000.0 * 8.0 * maintenance_neglect))
    o2_lag_ms = max(50.0, min(500.0, 80.0 + engine_hours / 10000.0 * 200.0 * maintenance_neglect))

    # ── v3 derived features ───────────────────────────────────────────────────
    coolant_oil_delta = oil_temp - engine_temp
    maf_throttle_ratio = (maf_val / max(throttle_pos, 1.0)) if maf_val is not None else 1.8
    intake_ambient_delta = (float(intake_air_temp) - ambient) if intake_air_temp is not None else 22.0
    egr_flow_rate = latest_metric(samples, ["egrFlowRate", "egr_flow_rate"], 20.0)
    oil_pressure_val = latest_metric(samples, ["oilPressure", "oil_pressure"], 45.0)
    fuel_trim_short = latest_metric(samples, ["fuelTrimShort", "fuel_trim_short"], 0.0)
    fuel_trim_long = latest_metric(samples, ["fuelTrimLong", "fuel_trim_long"], 0.0)
    dpf_differential_kpa = latest_metric(samples, ["dpfDifferentialPressure", "dpf_differential_kpa"], 3.0)
    exhaust_back_pressure = latest_metric(samples, ["exhaustBackPressure", "exhaust_back_pressure"], 10.0)
    engine_efficiency = latest_metric(samples, ["engineEfficiency", "engine_efficiency"], 0.75)
    rpm_variance = latest_metric(samples, ["rpmVarianceLoadAdj", "rpm_variance_load_adj"], 100.0)
    coolant_temp_osc = latest_metric(samples, ["coolantTempOscillation", "coolant_temp_oscillation"], 2.5)
    idle_heat_soak = latest_metric(samples, ["idleHeatSoak", "idle_heat_soak"], 5.0)
    throttle_lag_score = latest_metric(samples, ["throttleLagScore", "throttle_lag_score"], 80.0)

    return {
        "vehicle_class_code": (codes.get("vehicle_class_codes") or {}).get(vehicle_class, vc_code),
        "protocol_code": (codes.get("protocol_codes") or {}).get(protocol, 1),
        "make_code": (codes.get("make_codes") or {}).get(make, 0),
        "powertrain_code": (codes.get("powertrain_codes") or {}).get(powertrain, 1),
        "model_year": model_year,
        "odometer_miles": odometer,
        "engine_hours": engine_hours,
        "drive_cycle_phase_code": float(drive_phase),
        "time_since_start_min": time_since_start,
        "rpm": rpm,
        "engine_temp": engine_temp,
        "oil_temp": oil_temp,
        "transmission_temp": transmission_temp,
        "fuel_pressure": fuel_pressure,
        "fuel_rate": fuel_rate,
        "battery_voltage": battery_voltage,
        "vibration": vibration,
        "dpf_soot_load": dpf_soot,
        "brake_temp": brake_temp,
        "tire_pressure": tire_pressure,
        "ambient_temp_c": ambient,
        "elevation_ft": elevation_ft,
        "payload_ratio": payload_ratio,
        "road_grade_pct": road_grade_pct,
        "idle_hours_day": idle_hours_day,
        "stop_go_ratio": latest_metric(samples, ["stop_go_ratio", "stopGoRatio"], 0.35),
        "long_haul_ratio": latest_metric(samples, ["long_haul_ratio", "longHaulRatio"], 0.45),
        "towing_ratio": latest_metric(samples, ["towing_ratio", "towingRatio"], 0.10),
        "maintenance_neglect": maintenance_neglect,
        "sensor_missing_rate": 0.0 if samples else 0.25,
        "engine_temp_delta_30d": delta_from_profile(engine_temp, profile, "engine_temp"),
        "fuel_pressure_delta_30d": delta_from_profile(fuel_pressure, profile, "fuel_pressure"),
        "battery_voltage_delta_30d": delta_from_profile(battery_voltage, profile, "battery_voltage"),
        "vibration_delta_30d": delta_from_profile(vibration, profile, "vibration"),
        "dpf_soot_delta_30d": delta_from_profile(dpf_soot, profile, "dpf_soot_load"),
        "brake_temp_delta_30d": delta_from_profile(brake_temp, profile, "brake_temp"),
        # v3 derived
        "egr_flow_rate": egr_flow_rate,
        "coolant_oil_delta": coolant_oil_delta,
        "maf_throttle_ratio": maf_throttle_ratio,
        "intake_ambient_delta": intake_ambient_delta,
        "dpf_differential_kpa": dpf_differential_kpa,
        "oil_pressure": oil_pressure_val,
        "fuel_trim_short": fuel_trim_short,
        "fuel_trim_long": fuel_trim_long,
        "idle_heat_soak": idle_heat_soak,
        "throttle_lag_score": throttle_lag_score,
        "turbo_boost_kpa": turbo_boost_kpa,
        "exhaust_back_pressure": exhaust_back_pressure,
        "engine_efficiency": engine_efficiency,
        "rpm_variance_load_adj": rpm_variance,
        "coolant_temp_oscillation": coolant_temp_osc,
        # v4 atmosphere & aerodynamics
        "air_density_kg_m3": air_density,
        "aero_drag_kw": aero_drag_kw,
        "rolling_resistance_kw": rolling_res_kw,
        "road_load_kw": road_load_kw,
        "volumetric_efficiency_pct": vol_eff_pct,
        # v4 combustion & exhaust
        "bsfc_g_per_kwh": bsfc_g_kwh,
        "lambda_afr": lambda_afr,
        "egt_c": egt_c,
        "turbo_outlet_temp_c": turbo_outlet_temp_c,
        "scr_inlet_temp_c": scr_inlet_temp_c,
        "def_consumption_rate_pct": def_rate_pct,
        # v4 thermal
        "thermal_lag": thermal_lag,
        "heat_soak_delta_c": heat_soak_delta_c,
        "egr_cooler_fouling": egr_cooler_fouling,
        # v4 oil / lubrication
        "oil_viscosity_cst": oil_viscosity_cst,
        "oil_film_thickness_ratio": oil_film_ratio,
        "oil_tbn": oil_tbn,
        # v4 bearing & hub
        "bearing_wear_index": wear_index,
        "bearing_spall_stage": spall_stage,
        "hub_temp_fl_c": hub_fl,
        "hub_temp_fr_c": hub_fr,
        "hub_temp_rl_c": hub_rl,
        "hub_temp_rr_c": hub_rr,
        # v4 DPF
        "dpf_ash_pct": dpf_ash,
        "dpf_in_regen": dpf_regen,
        # v4 battery / electrical
        "battery_soh_pct": batt_soh,
        "battery_soc_pct": batt_soc,
        "alternator_deficit_w": alt_deficit_w,
        "cranking_voltage_v": cranking_v,
        # v4 sensor drift
        "sensor_coolant_error_c": coolant_error_c,
        "sensor_maf_error_pct": maf_error_pct,
        "sensor_o2_lag_ms": o2_lag_ms,
        # temporal acceleration features — 0.0 = no trend acceleration (neutral/healthy default)
        "hubTempFL_accel_h24": 0.0,
        "hubTempFR_accel_h24": 0.0,
        "hubTempRL_accel_h24": 0.0,
        "hubTempRR_accel_h24": 0.0,
        "coolantTemp_accel_h24": 0.0,
        "oilTemp_accel_h24": 0.0,
        "batteryVoltage_accel_h24": 0.0,
        "dpfSootLoad_accel_h24": 0.0,
        "bearingFreqScore_accel_h24": 0.0,
        "turboBearingTemp_accel_h24": 0.0,
    }


def confidence_stage(sample_count: int) -> tuple[str, float]:
    if sample_count < 50:
        return "pretrained_prior", 0.35
    if sample_count < 200:
        return "calibrating", 0.55 + min(sample_count, 199) / 1000
    return "vehicle_specific", min(0.95, 0.74 + sample_count / 5000)


def top_features(vector: dict, profile: dict, risk_probability: float) -> list[dict]:
    rows = []
    for metric in ["engine_temp", "fuel_pressure", "battery_voltage", "vibration", "dpf_soot_load", "brake_temp", "tire_pressure"]:
        baseline = profile.get("baselineMetrics", {}).get(metric, {})
        mean = _num(baseline.get("mean"))
        std = _num(baseline.get("std"), 1.0) or 1.0
        value = _num(vector.get(metric))
        if value is None or mean is None:
            continue
        z = abs((value - mean) / std)
        rows.append({"metric": metric, "value": value, "baselineMean": mean, "zScore": round(z, 3), "reason": f"{metric} compared against pretrained {profile.get('profileKey')} prior."})
    rows.sort(key=lambda item: item["zScore"], reverse=True)
    if risk_probability >= 0.5 and not rows:
        rows.append({"metric": "model_prior", "zScore": 0, "reason": "Risk came from pretrained profile prior and sparse telemetry."})
    return rows[:5]


@app.get("/model/status")
def model_status():
    load_artifacts()
    return {
        "ok": MODEL is not None,
        "modelLoaded": MODEL is not None,
        "modelVersion": METADATA.get("modelVersion"),
        "trainingSource": METADATA.get("trainingSource"),
        "rows": METADATA.get("rows"),
        "fleetSize": METADATA.get("fleet_size"),
        "profiles": len(PROFILES),
        "notes": METADATA.get("notes"),
    }


@app.get("/baselines/{profile_key}")
def baseline(profile_key: str):
    load_artifacts()
    profile = PROFILES.get(profile_key)
    if not profile:
        raise HTTPException(status_code=404, detail="baseline profile not found")
    return {"ok": True, "data": profile}


@app.post("/predict")
def predict(req: PredictRequest):
    load_artifacts()
    if MODEL is None:
        raise HTTPException(status_code=503, detail="model unavailable")
    profile = resolve_profile(req.vehicleMeta)
    vector = feature_vector(req, profile)
    features = MODEL.get("features", list(vector.keys()))
    input_df = pd.DataFrame([{key: vector.get(key, 0) for key in features}])
    model_type = MODEL.get("model_type", "single")
    thresholds = MODEL.get("thresholds", {})
    threshold = float(thresholds.get(req.alertMode, thresholds.get("launch_default", MODEL.get("threshold", 0.5))))
    if model_type == "ensemble":
        models = MODEL["models"]
        rf_weight = float(MODEL.get("rf_weight", 0.5))
        hgb_weight = float(MODEL.get("hgb_weight", 0.5))
        risk_probability = (rf_weight * float(models["random_forest"].predict_proba(input_df)[0, 1])) + (
            hgb_weight * float(models["hist_gradient_boosting"].predict_proba(input_df)[0, 1])
        )
    else:
        model = MODEL["model"]
        risk_probability = float(model.predict_proba(input_df)[0, 1]) if hasattr(model, "predict_proba") else float(model.predict(input_df)[0])

    stage, confidence = confidence_stage(len(req.samples))
    subsystem_priors = profile.get("subsystemPriors", {})
    return {
        "ok": True,
        "vehicleId": req.vehicleId,
        "orgId": req.orgId,
        "prediction": int(risk_probability >= threshold),
        "riskProbability": round(risk_probability, 6),
        "threshold": threshold,
        "confidence": round(confidence, 4),
        "confidenceStage": stage,
        "modelVersion": MODEL.get("model_version") or METADATA.get("modelVersion"),
        "trainingSource": MODEL.get("training_source") or METADATA.get("trainingSource"),
        "baselineProfile": {
            "profileKey": profile.get("profileKey"),
            "vehicleClass": profile.get("vehicleClass"),
            "make": profile.get("make"),
            "model": profile.get("model"),
            "protocol": profile.get("protocol"),
            "powertrain": profile.get("powertrain"),
            "failureRate": profile.get("failureRate"),
        },
        "sampleCount": len(req.samples),
        "dataQuality": {
            "stage": stage,
            "sampleCount": len(req.samples),
            "missingRate": vector.get("sensor_missing_rate", 0),
            "message": "Using pretrained synthetic priors; live telemetry calibrates this vehicle over time." if stage != "vehicle_specific" else "Vehicle-specific telemetry baseline is active.",
        },
        "topFeatures": top_features(vector, profile, risk_probability),
        "subsystemPriors": subsystem_priors,
        "featureVector": vector,
    }


def _run_training(args: list[str]) -> dict:
    cmd = [sys.executable, str(ROOT / "training" / "fleet_simulation.py"), *args]
    proc = subprocess.run(cmd, cwd=str(ROOT.parents[0]), capture_output=True, text=True, timeout=3600)
    if proc.returncode != 0:
        raise HTTPException(status_code=500, detail=proc.stderr[-2000:])
    load_artifacts(force=True)
    return {"ok": True, "stdout": proc.stdout[-4000:], "status": model_status()}


@app.post("/retrain/synthetic")
def retrain_synthetic():
    return _run_training(["--fleet-size", "10000", "--days", "45", "--observations-per-day", "1"])


@app.post("/retrain/real-world")
def retrain_real_world():
    raise HTTPException(status_code=501, detail="Real-world retraining requires an uploaded customer CSV and is intentionally not automatic.")


load_artifacts()
