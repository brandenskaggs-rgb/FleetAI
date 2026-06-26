"""Pretrained RF+HGB ensemble scorer — 5th signal in the live prediction pipeline.

Loads fleet_ai_model.pkl (trained by fleet_simulation.py v4) at startup and scores
new observations using live OBD-II metrics.  This is the cold-start prior; per-vehicle
Welford + Isolation Forest models override it as real telemetry accumulates.

v4 upgrade: 83 physics-derived features computed from live telemetry —
ISA air density, aerodynamic drag, Walther oil viscosity, ISO 281 bearing wear,
Arrhenius battery aging, DPF ash model, Peukert cranking voltage.
"""
from __future__ import annotations

import logging
import math
import threading
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

_MODEL_PATH = Path(__file__).resolve().parents[2] / "fleet_ai" / "models" / "fleet_ai_model.pkl"

# Default feature list — overridden by bundle["features"] at runtime.
PRETRAINED_FEATURE_COLUMNS = [
    "vehicle_class_code", "protocol_code", "make_code", "powertrain_code",
    "model_year", "odometer_miles", "engine_hours",
    "drive_cycle_phase_code", "time_since_start_min",
    "rpm", "engine_temp", "oil_temp", "transmission_temp",
    "fuel_pressure", "fuel_rate", "battery_voltage", "vibration",
    "dpf_soot_load", "brake_temp", "tire_pressure",
    "ambient_temp_c", "elevation_ft",
    "payload_ratio", "road_grade_pct", "idle_hours_day",
    "stop_go_ratio", "long_haul_ratio", "towing_ratio",
    "maintenance_neglect", "sensor_missing_rate",
    "engine_temp_delta_30d", "fuel_pressure_delta_30d",
    "battery_voltage_delta_30d", "vibration_delta_30d",
    "dpf_soot_delta_30d", "brake_temp_delta_30d",
    "egr_flow_rate", "coolant_oil_delta", "maf_throttle_ratio",
    "intake_ambient_delta", "dpf_differential_kpa", "oil_pressure",
    "fuel_trim_short", "fuel_trim_long", "idle_heat_soak",
    "throttle_lag_score", "turbo_boost_kpa", "exhaust_back_pressure",
    "engine_efficiency", "rpm_variance_load_adj", "coolant_temp_oscillation",
    # v4 — atmosphere & aerodynamics
    "air_density_kg_m3", "aero_drag_kw", "rolling_resistance_kw",
    "road_load_kw", "volumetric_efficiency_pct",
    # v4 — combustion & exhaust
    "bsfc_g_per_kwh", "lambda_afr", "egt_c", "turbo_outlet_temp_c",
    "scr_inlet_temp_c", "def_consumption_rate_pct",
    # v4 — thermal
    "thermal_lag", "heat_soak_delta_c", "egr_cooler_fouling",
    # v4 — oil / lubrication
    "oil_viscosity_cst", "oil_film_thickness_ratio", "oil_tbn",
    # v4 — bearing & hub
    "bearing_wear_index", "bearing_spall_stage",
    "hub_temp_fl_c", "hub_temp_fr_c", "hub_temp_rl_c", "hub_temp_rr_c",
    # v4 — DPF / emissions
    "dpf_ash_pct", "dpf_in_regen",
    # v4 — battery / electrical
    "battery_soh_pct", "battery_soc_pct", "alternator_deficit_w", "cranking_voltage_v",
    # v4 — sensor drift
    "sensor_coolant_error_c", "sensor_maf_error_pct", "sensor_o2_lag_ms",
]

_VEHICLE_CLASS_CODES: dict[str, int] = {
    "heavy_duty_j1939": 0, "heavy": 0, "heavy_duty": 0,
    "medium_duty": 1, "medium": 1,
    "light_duty_truck": 2, "light": 2, "light_duty": 2,
    "cargo_van": 3, "van": 3,
    "passenger_car": 4, "car": 4, "passenger": 4,
}
_PROTOCOL_CODES: dict[str, int] = {"j1939": 0, "obd2": 1, "obd-ii": 1}
_POWERTRAIN_CODES: dict[str, int] = {"diesel": 0, "gasoline": 1, "gas": 1, "hybrid": 2, "electric": 2}
_MAKE_CODES: dict[str, int] = {
    "chevrolet": 0, "ford": 1, "freightliner": 2, "international": 3,
    "kenworth": 4, "peterbilt": 5, "ram": 6, "toyota": 7, "volvo": 8,
}

# Per-class physics specs (mass_kg, frontal_m2, Cd, Crr, engine_kw, alt_kw)
_PHYS_SPECS = {
    0: {"mass": 15000, "A": 9.0,  "Cd": 0.68, "Crr": 0.006, "eng_kw": 340, "alt_kw": 4.5, "dpf": True},
    1: {"mass":  8000, "A": 7.0,  "Cd": 0.65, "Crr": 0.007, "eng_kw": 200, "alt_kw": 3.0, "dpf": True},
    2: {"mass":  3500, "A": 3.2,  "Cd": 0.45, "Crr": 0.010, "eng_kw": 150, "alt_kw": 1.8, "dpf": False},
    3: {"mass":  3200, "A": 4.0,  "Cd": 0.55, "Crr": 0.009, "eng_kw": 130, "alt_kw": 1.6, "dpf": False},
    4: {"mass":  1800, "A": 2.2,  "Cd": 0.30, "Crr": 0.011, "eng_kw":  85, "alt_kw": 1.2, "dpf": False},
}

# Fleet-average defaults for features not derivable from live telemetry
_DEFAULTS: dict[str, float] = {
    "vehicle_class_code": 0, "protocol_code": 0, "make_code": 2, "powertrain_code": 0,
    "model_year": 2020, "odometer_miles": 150000, "engine_hours": 5000,
    "drive_cycle_phase_code": 2, "time_since_start_min": 45,
    "rpm": 1400, "engine_temp": 88, "oil_temp": 96, "transmission_temp": 85,
    "fuel_pressure": 60, "fuel_rate": 6.0, "battery_voltage": 13.8, "vibration": 0.30,
    "dpf_soot_load": 25, "brake_temp": 100, "tire_pressure": 680,
    "ambient_temp_c": 18, "elevation_ft": 900,
    "payload_ratio": 0.70, "road_grade_pct": 1.0, "idle_hours_day": 1.5,
    "stop_go_ratio": 0.30, "long_haul_ratio": 0.60, "towing_ratio": 0.20,
    "maintenance_neglect": 0.20, "sensor_missing_rate": 0.05,
    "engine_temp_delta_30d": 2.0, "fuel_pressure_delta_30d": -0.5,
    "battery_voltage_delta_30d": -0.02, "vibration_delta_30d": 0.05,
    "dpf_soot_delta_30d": 3.0, "brake_temp_delta_30d": 2.0,
    "egr_flow_rate": 20.0, "coolant_oil_delta": 8.0, "maf_throttle_ratio": 1.8,
    "intake_ambient_delta": 22.0, "dpf_differential_kpa": 3.0, "oil_pressure": 45.0,
    "fuel_trim_short": 0.0, "fuel_trim_long": 0.0, "idle_heat_soak": 5.0,
    "throttle_lag_score": 80.0, "turbo_boost_kpa": 100.0, "exhaust_back_pressure": 10.0,
    "engine_efficiency": 0.75, "rpm_variance_load_adj": 100.0, "coolant_temp_oscillation": 2.5,
}

# ── Physics helper functions ──────────────────────────────────────────────────

def _isa_density(altitude_ft: float, ambient_c: float) -> float:
    """International Standard Atmosphere air density kg/m³."""
    alt_m = altitude_ft * 0.3048
    T_k = max(200.0, ambient_c + 273.15)
    if alt_m < 11000:
        P_pa = 101325.0 * (1.0 - 2.2558e-5 * alt_m) ** 5.2559
    else:
        P_pa = 101325.0 * 0.22336 * math.exp(-1.5769e-4 * (alt_m - 11000))
    return max(0.5, P_pa / (287.058 * T_k))


def _walther_viscosity(oil_temp_c: float) -> float:
    """Walther equation: kinematic viscosity (cSt) for 15W-40 engine oil."""
    T_k = max(243.0, min(473.0, oil_temp_c + 273.15))
    log_T = math.log10(T_k)
    exponent = max(-2.0, min(3.0, 7.949 - 3.061 * log_T))
    nu = 10.0 ** (10.0 ** exponent) - 0.7
    return max(1.0, min(2000.0, nu))


def _oil_film_ratio(viscosity_cst: float, rpm: float, engine_load_pct: float) -> float:
    """
    Stribeck-curve film thickness ratio (1.0 = full hydrodynamic, 0 = boundary).
    hm ∝ (η·N/P)^0.7; normalised to healthy operating point.
    """
    eta = viscosity_cst * 1e-6  # m²/s → roughly Pa·s at unit density
    N = max(1.0, rpm) / 60.0    # rps
    P = max(0.01, engine_load_pct / 100.0)
    raw = (eta * N / P) ** 0.7
    nominal = (8e-6 * 25.0 / 0.6) ** 0.7
    return min(1.0, max(0.0, raw / nominal))


def _oil_tbn_estimate(engine_hours: float, oil_temp_c: float,
                      maintenance_neglect: float) -> float:
    """
    Arrhenius TBN depletion.  Fresh oil = 10, depleted = 0.
    Rate doubles per 10 °C above 95 °C baseline.
    """
    T_excess = max(0.0, oil_temp_c - 95.0)
    rate = 0.0025 * (2.0 ** (T_excess / 10.0)) * (1.0 + maintenance_neglect * 0.5)
    oil_change_interval = max(200.0, 300.0 * (1.0 - maintenance_neglect * 0.6))
    hrs_since_change = engine_hours % max(oil_change_interval, 50.0)
    return max(0.0, min(10.0, 10.0 * math.exp(-rate * hrs_since_change)))


def _bearing_wear(odometer_miles: float, engine_hours: float, vehicle_class_code: int,
                  payload_ratio: float, maintenance_neglect: float,
                  engine_temp_c: float) -> tuple[float, float]:
    """
    Field-calibrated hub bearing wear index and spall stage.
    L10 base (hours) calibrated to fleet replacement mileage intervals.
    """
    bases = {0: 26000, 1: 17000, 2: 8000, 3: 9000, 4: 5000}
    service_mi = {0: 480000, 1: 300000, 2: 140000, 3: 160000, 4: 100000}
    avg_mph  = {0: 38, 1: 32, 2: 27, 3: 27, 4: 31}

    l10_base  = bases.get(vehicle_class_code, 13000)
    svc_mi    = service_mi.get(vehicle_class_code, 200000)
    speed_mph = avg_mph.get(vehicle_class_code, 30)

    load_factor  = max(0.4, min(1.3, 1.0 - (payload_ratio - 0.5) * 0.4))
    maint_factor = max(0.3, min(1.0, 1.0 - maintenance_neglect * 0.55))
    l10 = max(800.0, l10_base * load_factor * maint_factor)

    # Use modulo so service resets wear (as in simulation)
    svc_interval_adj = max(40000.0, svc_mi * max(0.5, 1.0 + (1.0 - maintenance_neglect) * 0.25
                                                  - maintenance_neglect * 0.15))
    miles_since = odometer_miles % svc_interval_adj
    hrs_bearing  = miles_since / max(speed_mph, 1.0)

    temp_factor = max(1.0, min(2.5, 1.0 + max(0.0, engine_temp_c - 95.0) * 0.025))
    wear_index  = min(3.0, hrs_bearing / max(l10, 100.0) * temp_factor)

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
    """Arrhenius SOH aging, calibrated to 3-5 yr lead-acid fleet life."""
    batt_interval = max(2.0, min(6.0, 3.5 + (1.0 - maintenance_neglect) * 1.5))
    eff_age = age_years % batt_interval
    T_excess = max(0.0, avg_temp_c - 25.0)
    rate = 7.0 * (2.0 ** (T_excess / 10.0)) * (1.0 + idle_hrs_day * 0.06)
    return max(30.0, min(100.0, 100.0 - rate * eff_age))


def _cranking_voltage(battery_soh: float, ambient_c: float) -> float:
    """Peukert-based cold-start voltage sag under 250 A cranking load."""
    soh_f = battery_soh / 100.0
    v_oc  = 12.4 + 0.3 * soh_f
    T_k   = max(233.0, ambient_c + 273.15)
    r_int = max(0.005, (0.012 * (1.0 - soh_f * 0.6)) * (298.0 / T_k) ** 1.5)
    return max(8.0, min(14.5, v_oc - 250 * r_int))


def _dpf_ash(engine_hours: float, vehicle_class_code: int,
             maintenance_neglect: float, is_diesel: bool) -> float:
    if not is_diesel:
        return 0.0
    ash_cap_g  = {0: 5000.0, 1: 2500.0, 2: 1000.0, 3: 1000.0, 4: 500.0}
    cap = ash_cap_g.get(vehicle_class_code, 2500.0)
    ash_g = engine_hours * 0.50 * (1.0 + maintenance_neglect * 0.8)
    return min(100.0, ash_g / cap * 100.0)


class PretrainedScorer:
    """Thread-safe loader and scorer for the pretrained RF+HGB fleet model."""

    def __init__(self) -> None:
        self._bundle: Optional[dict] = None
        self._lock = threading.Lock()
        self._load_error: Optional[str] = None

    def load(self) -> bool:
        with self._lock:
            if self._bundle is not None:
                return True
            try:
                import joblib
                bundle = joblib.load(_MODEL_PATH)
                if not isinstance(bundle, dict) or bundle.get("model_type") != "ensemble":
                    self._load_error = f"Unexpected bundle format at {_MODEL_PATH}"
                    return False
                self._bundle = bundle
                ver = bundle.get("model_version", "?")
                feats = len(bundle.get("features", []))
                logger.info(f"[pretrained] Loaded model v{ver} ({feats} features) from {_MODEL_PATH}")
                return True
            except Exception as exc:
                self._load_error = str(exc)
                logger.warning(f"[pretrained] Could not load model from {_MODEL_PATH}: {exc}")
                return False

    @property
    def is_loaded(self) -> bool:
        return self._bundle is not None

    def _build_row(
        self,
        current_metrics: dict,
        window_stats: dict,
        vehicle_meta: Optional[dict],
    ) -> dict[str, float]:
        meta = vehicle_meta or {}

        # ── Categorical encodings ────────────────────────────────────────────
        vc_raw = str(meta.get("vehicleClass", "heavy_duty_j1939")).lower().replace(" ", "_").replace("-", "_")
        vehicle_class_code = _VEHICLE_CLASS_CODES.get(vc_raw, 0)
        pt_raw = str(meta.get("powertrain", "diesel")).lower()
        powertrain_code = _POWERTRAIN_CODES.get(pt_raw, 0)
        protocol_code = 0 if vehicle_class_code <= 1 else 1
        make_raw = str(meta.get("make", "")).strip().lower()
        make_code = _MAKE_CODES.get(make_raw, _DEFAULTS["make_code"])

        # ── Vehicle specs for physics computations ───────────────────────────
        specs = _PHYS_SPECS.get(vehicle_class_code, _PHYS_SPECS[0])
        is_diesel = powertrain_code == 0
        model_year_val = int(meta.get("year", _DEFAULTS["model_year"]))
        age_years = max(0.0, 2026.0 - model_year_val)
        odometer_miles = float(meta.get("odometer", _DEFAULTS["odometer_miles"]))
        engine_hours = float(meta.get("engineHours", _DEFAULTS["engine_hours"]))

        # ── Helper accessors ─────────────────────────────────────────────────
        def _cm(key: str, default: float) -> float:
            v = current_metrics.get(key)
            return float(v) if v is not None else default

        def _ws_delta(key: str, default: float) -> float:
            stats = window_stats.get(key, {})
            recent = (stats.get("h24") or {}).get("mean")
            all_m  = (stats.get("all")  or {}).get("mean")
            if recent is not None and all_m is not None:
                return float(recent) - float(all_m)
            return default

        def _ws_mean(key: str, default: float) -> float:
            stats = window_stats.get(key, {})
            v = (stats.get("all") or {}).get("mean")
            return float(v) if v is not None else default

        # ── Core OBD-II readings ─────────────────────────────────────────────
        rpm           = _cm("rpm",        _DEFAULTS["rpm"])
        engine_temp   = _cm("coolantTemp", _DEFAULTS["engine_temp"])
        oil_temp      = _cm("oilTemp",     _DEFAULTS["oil_temp"])
        battery_voltage = _cm("batteryVoltage", _DEFAULTS["battery_voltage"])
        fuel_rate     = _cm("fuelRate",    _DEFAULTS["fuel_rate"])
        dpf_soot_load = _cm("dpfSootLoad", _DEFAULTS["dpf_soot_load"])
        throttle_pos  = _cm("throttlePos", 25.0)
        maf           = current_metrics.get("maf")
        intake_air_temp = current_metrics.get("intakeAirTemp")
        map_kpa       = current_metrics.get("intakeManifoldPressure")
        vehicle_speed_kph = _cm("vehicleSpeed", 60.0)
        ambient       = _cm("ambientTemp", _DEFAULTS["ambient_temp_c"])
        elevation_ft  = float(meta.get("elevation", _DEFAULTS["elevation_ft"]))

        # ── Operational profile ──────────────────────────────────────────────
        maintenance_neglect = min(1.0, age_years / 20.0 + 0.1)
        payload_ratio  = float(meta.get("payloadRatio", _DEFAULTS["payload_ratio"]))
        idle_hours_day = float(meta.get("idleHoursDay", _DEFAULTS["idle_hours_day"]))

        # ── Deltas from window_stats ─────────────────────────────────────────
        engine_temp_delta  = _ws_delta("coolantTemp",    _DEFAULTS["engine_temp_delta_30d"])
        fuel_pressure_delta = _ws_delta("fuelPressure",  _DEFAULTS["fuel_pressure_delta_30d"])
        batt_delta         = _ws_delta("batteryVoltage", _DEFAULTS["battery_voltage_delta_30d"])
        dpf_delta          = _ws_delta("dpfSootLoad",    _DEFAULTS["dpf_soot_delta_30d"])

        # ── v3 derived features ──────────────────────────────────────────────
        coolant_oil_delta = oil_temp - engine_temp

        maf_throttle_ratio = _DEFAULTS["maf_throttle_ratio"]
        if maf is not None and throttle_pos > 0:
            maf_throttle_ratio = float(maf) / max(float(throttle_pos), 1.0)

        intake_ambient_delta = (
            float(intake_air_temp) - ambient if intake_air_temp is not None
            else _DEFAULTS["intake_ambient_delta"]
        )

        turbo_boost_kpa = _DEFAULTS["turbo_boost_kpa"]
        if map_kpa is not None:
            turbo_boost_kpa = max(0.0, float(map_kpa) - 101.325)

        # ── v4 Physics: atmosphere & aerodynamics ────────────────────────────
        air_density = _isa_density(elevation_ft, ambient)
        v_ms = max(0.0, vehicle_speed_kph / 3.6)
        F_drag = 0.5 * air_density * specs["Cd"] * specs["A"] * v_ms ** 2
        aero_drag_kw = F_drag * v_ms / 1000.0
        rolling_res_kw = specs["Crr"] * specs["mass"] * 9.81 * v_ms / 1000.0
        grade_pct = float(meta.get("roadGradePct", _DEFAULTS["road_grade_pct"]))
        grade_force_kw = specs["mass"] * 9.81 * math.sin(math.atan(grade_pct / 100.0)) * v_ms / 1000.0
        road_load_kw = max(0.0, aero_drag_kw + rolling_res_kw + grade_force_kw)
        # Volumetric efficiency: lower at altitude (less dense air)
        rho_sl = 1.225  # sea-level density
        vol_eff_pct = min(100.0, max(30.0, air_density / rho_sl * 100.0))

        # ── v4 Physics: combustion & exhaust ─────────────────────────────────
        engine_load_pct = min(100.0, max(0.0, road_load_kw / max(specs["eng_kw"] * 0.01, 0.01)))
        # BSFC: 2-D Gaussian well — optimal at ~1700 RPM, ~72% load
        rpm_ratio  = (rpm - 1700.0) / 600.0
        load_ratio = (engine_load_pct - 72.0) / 30.0
        bsfc_base  = 195.0 if is_diesel else 270.0
        bsfc_g_kwh = bsfc_base * math.exp(0.5 * (rpm_ratio ** 2 + load_ratio ** 2))
        bsfc_g_kwh = min(600.0, max(140.0, bsfc_g_kwh))
        # Lambda AFR (altitude correction makes engine run rich at high altitude)
        target_afr = 14.7 if not is_diesel else 35.0
        actual_afr = target_afr * (air_density / rho_sl)
        lambda_afr = actual_afr / target_afr
        # EGT estimate from load and RPM (if sensor not available)
        egt_c_live = _cm("egt", -1.0)
        if egt_c_live < 0:
            egt_c = max(150.0, min(850.0,
                250.0 + 4.5 * engine_load_pct + 0.08 * rpm
                + (50 if is_diesel else 0) - 1.5 * vehicle_speed_kph * 0.05))
        else:
            egt_c = egt_c_live
        # Turbo compressor outlet: T2 = T1 * (1 + (PR^((γ-1)/γ) - 1) / η_c)
        PR = max(1.0, 1.0 + turbo_boost_kpa / 101.325)
        T1_k = max(250.0, ambient + 273.15)
        turbo_outlet_c = T1_k * (1.0 + (PR ** (0.2857) - 1.0) / 0.72) - 273.15
        # SCR inlet temperature
        scr_inlet_c = max(100.0, egt_c - (80.0 + 0.4 * vehicle_speed_kph))
        # DEF consumption (diesel only; SCR light-off at 200°C)
        def_rate_pct = 0.0
        if is_diesel and scr_inlet_c > 200.0:
            def_rate_pct = min(8.0, max(0.0, (scr_inlet_c - 200.0) / 60.0 * 3.5))

        # ── v4 Physics: thermal ──────────────────────────────────────────────
        # Thermal lag: how far from steady state (0=at steady state, 1=just started)
        time_since_start = _cm("timeSinceStart", _DEFAULTS["time_since_start_min"])
        therm_mass_factor = 1.0 if vehicle_class_code <= 1 else 0.5
        thermal_lag = math.exp(-time_since_start / max(1.0, 20.0 * therm_mass_factor))
        # Heat soak delta after shutdown (turbo bearing temperature rise)
        is_idle = vehicle_speed_kph < 2.0 and rpm < 900
        heat_soak_delta = max(0.0, 12.0 + egt_c * 0.04 - 5.0 * vehicle_speed_kph / 80.0) if is_idle else 0.0
        # EGR cooler fouling index (increases with mileage and neglect)
        egr_fouling = min(1.0, max(0.0, odometer_miles / 800000.0 * (0.8 + maintenance_neglect * 0.4)))

        # ── v4 Physics: oil / lubrication ────────────────────────────────────
        oil_viscosity = _walther_viscosity(oil_temp)
        oil_film_ratio = _oil_film_ratio(oil_viscosity, rpm, engine_load_pct)
        oil_tbn = _oil_tbn_estimate(engine_hours, oil_temp, maintenance_neglect)

        # ── v4 Physics: bearing & hub ────────────────────────────────────────
        wear_index, spall_stage = _bearing_wear(
            odometer_miles, engine_hours, vehicle_class_code,
            payload_ratio, maintenance_neglect, engine_temp)
        # Hub temps: if physical sensors available use them; else estimate from wear index
        hub_fl = _cm("hubTempFL", -1.0)
        hub_fr = _cm("hubTempFR", -1.0)
        hub_rl = _cm("hubTempRL", -1.0)
        hub_rr = _cm("hubTempRR", -1.0)
        if hub_fl < 0:
            # Estimate from physics: Q_gen = mu × F × omega × r / (h_conv × A)
            mu_est = 0.0015 + wear_index * 0.003
            h_conv = 8.0 + 0.22 * min(vehicle_speed_kph, 130.0)
            omega  = max(0.1, vehicle_speed_kph / 3.6 / 3.2) * (2 * math.pi)
            load_n = specs["mass"] * max(0.10, 0.14 + payload_ratio * 0.06)
            Q_w    = mu_est * load_n * omega * 0.065
            hub_est = min(200.0, ambient + Q_w / max(0.1, h_conv * 0.04))
            hub_fl = hub_fr = hub_rl = hub_rr = hub_est

        # ── v4 Physics: DPF / emissions ──────────────────────────────────────
        dpf_ash = _dpf_ash(engine_hours, vehicle_class_code, maintenance_neglect, is_diesel)
        dpf_regen = 1.0 if (is_diesel and dpf_soot_load >= 78.0) else 0.0

        # ── v4 Physics: battery / electrical ─────────────────────────────────
        avg_temp_c = _ws_mean("ambientTemp", ambient)
        batt_soh = _battery_soh(age_years, avg_temp_c, idle_hours_day, maintenance_neglect)
        batt_soc = min(100.0, max(20.0,
            95.0 - 15.0 * float(meta.get("stopGoRatio", 0.3))
            + (batt_delta * 50.0 if abs(batt_delta) < 0.5 else 0.0)))
        alt_output_w = min(specs["alt_kw"] * 1000.0, specs["alt_kw"] * 1000.0 * min(1.0, rpm / 1400.0))
        hvac_w = max(0.0, (abs(ambient - 22.0) / 15.0) * 1200.0)
        accessory_w = hvac_w + 400.0  # base electrical load
        alt_deficit_w = max(-2000.0, min(2000.0, accessory_w - alt_output_w))
        cranking_v = _cranking_voltage(batt_soh, ambient)

        # ── v4: sensor drift ─────────────────────────────────────────────────
        coolant_error_c = max(0.0, min(8.0, odometer_miles / 600000.0 * 4.0 * maintenance_neglect))
        maf_error_pct   = max(0.0, min(15.0, odometer_miles / 500000.0 * 8.0 * maintenance_neglect))
        o2_lag_ms       = max(50.0, min(500.0, 80.0 + engine_hours / 10000.0 * 200.0 * maintenance_neglect))

        return {
            # identity
            "vehicle_class_code": float(vehicle_class_code),
            "protocol_code":      float(protocol_code),
            "make_code":          float(make_code),
            "powertrain_code":    float(powertrain_code),
            "model_year":         float(model_year_val),
            "odometer_miles":     odometer_miles,
            "engine_hours":       engine_hours,
            # drive cycle
            "drive_cycle_phase_code": 2.0,  # assume cruise
            "time_since_start_min":   time_since_start,
            # core OBD-II
            "rpm":               rpm,
            "engine_temp":       engine_temp,
            "oil_temp":          oil_temp,
            "transmission_temp": _cm("transmissionTemp", _DEFAULTS["transmission_temp"]),
            "fuel_pressure":     _cm("fuelPressure", _DEFAULTS["fuel_pressure"]),
            "fuel_rate":         fuel_rate,
            "battery_voltage":   battery_voltage,
            "vibration":         _cm("vibration", _DEFAULTS["vibration"]),
            "dpf_soot_load":     dpf_soot_load,
            "brake_temp":        _cm("brakeTemp", _DEFAULTS["brake_temp"]),
            "tire_pressure":     _cm("tirePressure", _DEFAULTS["tire_pressure"]),
            "ambient_temp_c":    ambient,
            "elevation_ft":      elevation_ft,
            # operational
            "payload_ratio":    payload_ratio,
            "road_grade_pct":   grade_pct,
            "idle_hours_day":   idle_hours_day,
            "stop_go_ratio":    float(meta.get("stopGoRatio", _DEFAULTS["stop_go_ratio"])),
            "long_haul_ratio":  float(meta.get("longHaulRatio", _DEFAULTS["long_haul_ratio"])),
            "towing_ratio":     float(meta.get("towingRatio", _DEFAULTS["towing_ratio"])),
            "maintenance_neglect": maintenance_neglect,
            "sensor_missing_rate": _DEFAULTS["sensor_missing_rate"],
            # deltas
            "engine_temp_delta_30d":    engine_temp_delta,
            "fuel_pressure_delta_30d":  fuel_pressure_delta,
            "battery_voltage_delta_30d": batt_delta,
            "vibration_delta_30d":       _DEFAULTS["vibration_delta_30d"],
            "dpf_soot_delta_30d":        dpf_delta,
            "brake_temp_delta_30d":      _DEFAULTS["brake_temp_delta_30d"],
            # v3
            "egr_flow_rate":          _DEFAULTS["egr_flow_rate"],
            "coolant_oil_delta":       coolant_oil_delta,
            "maf_throttle_ratio":      maf_throttle_ratio,
            "intake_ambient_delta":    intake_ambient_delta,
            "dpf_differential_kpa":   _DEFAULTS["dpf_differential_kpa"],
            "oil_pressure":           _cm("oilPressure", _DEFAULTS["oil_pressure"]),
            "fuel_trim_short":        _cm("fuelTrimShort", _DEFAULTS["fuel_trim_short"]),
            "fuel_trim_long":         _cm("fuelTrimLong", _DEFAULTS["fuel_trim_long"]),
            "idle_heat_soak":         _DEFAULTS["idle_heat_soak"],
            "throttle_lag_score":     _DEFAULTS["throttle_lag_score"],
            "turbo_boost_kpa":        turbo_boost_kpa,
            "exhaust_back_pressure":  _DEFAULTS["exhaust_back_pressure"],
            "engine_efficiency":      min(1.0, 1.0 - bsfc_g_kwh / 600.0),
            "rpm_variance_load_adj":  _DEFAULTS["rpm_variance_load_adj"],
            "coolant_temp_oscillation": abs(engine_temp_delta) * 0.5,
            # v4 aero
            "air_density_kg_m3":      air_density,
            "aero_drag_kw":           aero_drag_kw,
            "rolling_resistance_kw":  rolling_res_kw,
            "road_load_kw":           road_load_kw,
            "volumetric_efficiency_pct": vol_eff_pct,
            # v4 combustion
            "bsfc_g_per_kwh":         bsfc_g_kwh,
            "lambda_afr":             lambda_afr,
            "egt_c":                  egt_c,
            "turbo_outlet_temp_c":    turbo_outlet_c,
            "scr_inlet_temp_c":       scr_inlet_c,
            "def_consumption_rate_pct": def_rate_pct,
            # v4 thermal
            "thermal_lag":            thermal_lag,
            "heat_soak_delta_c":      heat_soak_delta,
            "egr_cooler_fouling":     egr_fouling,
            # v4 oil
            "oil_viscosity_cst":      oil_viscosity,
            "oil_film_thickness_ratio": oil_film_ratio,
            "oil_tbn":                oil_tbn,
            # v4 bearing
            "bearing_wear_index":     wear_index,
            "bearing_spall_stage":    spall_stage,
            "hub_temp_fl_c":          hub_fl,
            "hub_temp_fr_c":          hub_fr,
            "hub_temp_rl_c":          hub_rl,
            "hub_temp_rr_c":          hub_rr,
            # v4 DPF
            "dpf_ash_pct":            dpf_ash,
            "dpf_in_regen":           dpf_regen,
            # v4 battery
            "battery_soh_pct":        batt_soh,
            "battery_soc_pct":        batt_soc,
            "alternator_deficit_w":   alt_deficit_w,
            "cranking_voltage_v":     cranking_v,
            # v4 sensor drift
            "sensor_coolant_error_c": coolant_error_c,
            "sensor_maf_error_pct":   maf_error_pct,
            "sensor_o2_lag_ms":       o2_lag_ms,
        }

    def score(
        self,
        current_metrics: dict,
        window_stats: dict,
        vehicle_meta: Optional[dict] = None,
    ) -> Optional[float]:
        """Return a risk probability [0, 1], or None if model not loaded."""
        if not self.is_loaded:
            return None
        try:
            bundle = self._bundle
            feature_cols = bundle.get("features", PRETRAINED_FEATURE_COLUMNS)
            row   = self._build_row(current_metrics, window_stats, vehicle_meta)
            X_arr = np.array([[row.get(f, 0.0) for f in feature_cols]], dtype=np.float64)
            X     = pd.DataFrame(X_arr, columns=feature_cols)
            rf_w  = float(bundle.get("rf_weight", 0.5))
            hgb_w = float(bundle.get("hgb_weight", 0.5))
            models = bundle["models"]
            cals   = bundle.get("calibrators", {}) or {}

            rf_raw  = models["random_forest"].predict_proba(X)[0, 1]
            hgb_raw = models["hist_gradient_boosting"].predict_proba(X)[0, 1]

            # Apply isotonic calibration if available (v4.1+ models)
            rf_cal  = cals.get("random_forest")
            hgb_cal = cals.get("hist_gradient_boosting")
            rf_prob  = float(rf_cal.predict([rf_raw])[0])   if rf_cal  is not None else rf_raw
            hgb_prob = float(hgb_cal.predict([hgb_raw])[0]) if hgb_cal is not None else hgb_raw

            return float(np.clip(rf_w * rf_prob + hgb_w * hgb_prob, 0.0, 1.0))
        except Exception as exc:
            logger.debug(f"[pretrained] score error: {exc}")
            return None


# Module-level singleton — shared across all requests
_scorer = PretrainedScorer()


def load_pretrained() -> bool:
    """Call during app startup (lifespan). Returns True if model loaded."""
    return _scorer.load()


def score_pretrained(
    current_metrics: dict,
    window_stats: dict,
    vehicle_meta: Optional[dict] = None,
) -> Optional[float]:
    """Return [0, 1] risk probability from the pretrained model, or None."""
    return _scorer.score(current_metrics, window_stats, vehicle_meta)


def is_pretrained_loaded() -> bool:
    return _scorer.is_loaded
