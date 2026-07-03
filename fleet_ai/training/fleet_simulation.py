"""
Fleet AI Physics-Informed Simulation Engine — v4.0.0

Replaces v3 statistical approximations with real thermodynamic, tribological,
aerodynamic, and electrochemical physics models that produce failure signatures
matching real fleet telemetry patterns.

Physics modules:
  ISA atmosphere    — altitude + temp → air density, volumetric efficiency
  Aerodynamic drag  — Cd × A × rho × v², crosswind, rolling resistance
  BSFC map          — 2-D Gaussian efficiency well → fuel rate from power demand
  Newton cooling    — thermal lag, heat soak, thermostat dynamics, turbo soak
  Walther viscosity — oil film thickness vs temperature (Stribeck curve)
  Archard / L10     — bearing fatigue life, spall staging, hub temperatures
  DPF state machine — passive/active regen, ash accumulation, fouling
  Battery physics   — Peukert capacity, Arrhenius aging, alternator deficit
  EGT / SCR chain   — exhaust gas temperature → catalyst inlet → DEF efficiency
  Sensor drift      — O2 lag degradation, MAF fouling, coolant NTC offset
  Drive cycle FSM   — cold_start, warmup, city, cruise, grade, idle, heat_soak
  EGR cooler foul   — fouling thermal resistance, cooler delta degradation
"""
from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (accuracy_score, brier_score_loss, f1_score,
                             precision_score, recall_score, roc_auc_score)
from sklearn.model_selection import GroupShuffleSplit, train_test_split

MODEL_VERSION = "physics-v4.3.0"
TRAINING_SOURCE = "physics_calibrated_v4"

# ── Identity codes ─────────────────────────────────────────────────────────────
VEHICLE_CLASS_CODES = {
    "heavy_duty_j1939": 0, "medium_duty": 1, "light_duty_truck": 2,
    "cargo_van": 3, "passenger_car": 4,
}
PROTOCOL_CODES  = {"J1939": 0, "OBD2": 1}
POWERTRAIN_CODES = {"diesel": 0, "gasoline": 1, "hybrid": 2}
DRIVE_CYCLE_CODES = {
    "cold_start": 0, "warmup": 1, "city": 2, "cruise": 3,
    "grade": 4, "idle": 5, "heat_soak": 6,
}

MAKE_MODEL_PROFILES = [
    ("Freightliner", "Cascadia",   "heavy_duty_j1939", "J1939", "diesel"),
    ("Volvo",        "VNL",        "heavy_duty_j1939", "J1939", "diesel"),
    ("Peterbilt",    "579",        "heavy_duty_j1939", "J1939", "diesel"),
    ("Kenworth",     "T680",       "heavy_duty_j1939", "J1939", "diesel"),
    ("International","LT",         "heavy_duty_j1939", "J1939", "diesel"),
    ("Freightliner", "M2",         "medium_duty",      "J1939", "diesel"),
    ("Ford",         "F-650",      "medium_duty",      "J1939", "diesel"),
    ("Ford",         "F-150",      "light_duty_truck", "OBD2",  "gasoline"),
    ("Ford",         "F-250",      "light_duty_truck", "OBD2",  "gasoline"),
    ("Chevrolet",    "Silverado",  "light_duty_truck", "OBD2",  "gasoline"),
    ("Ram",          "2500",       "light_duty_truck", "OBD2",  "gasoline"),
    ("Ford",         "Transit",    "cargo_van",        "OBD2",  "gasoline"),
    ("Chevrolet",    "Express",    "cargo_van",        "OBD2",  "gasoline"),
    ("Ram",          "ProMaster",  "cargo_van",        "OBD2",  "gasoline"),
    ("Toyota",       "Camry",      "passenger_car",    "OBD2",  "gasoline"),
    ("Toyota",       "RAV4",       "passenger_car",    "OBD2",  "hybrid"),
]
MAKE_CODES = {make: idx for idx, make in enumerate(sorted({p[0] for p in MAKE_MODEL_PROFILES}))}

# ── Per-class physical specifications ─────────────────────────────────────────
# Used by every physics module.  All values are typical for the class.
_PHYS = {
    # class_key: (mass_kg, frontal_m2, cd, tire_circ_m, crr_base,
    #             engine_kw, bsfc_min, rpm_bsfc_opt, load_bsfc_opt,
    #             therm_mass_kj_c, batt_ah, alt_kw, bearing_C_kn, dpf_cap_g,
    #             rpm_idle, turbo_pr_max, stoich_afr, oil_cap_l)
    "heavy_duty_j1939":  (36000,  9.4, 0.60, 3.20, 0.0065,
                           450,  195, 1700, 0.72,
                           95.0, 200, 3.5,  380,  7000,
                           650,  3.2, 14.5, 38.0),
    "medium_duty":       (12000,  6.8, 0.65, 2.90, 0.0070,
                           200,  210, 1600, 0.70,
                           55.0, 110, 2.2,  180,  3500,
                           700,  2.8, 14.5, 15.0),
    "light_duty_truck":  ( 3800,  3.3, 0.45, 2.20, 0.0080,
                           290,  260, 2200, 0.65,
                           22.0,  70, 1.4,   50,     0,
                           750,  1.5, 14.7,  6.0),
    "cargo_van":         ( 4500,  4.2, 0.52, 2.30, 0.0078,
                           220,  270, 2000, 0.62,
                           24.0,  75, 1.6,   55,     0,
                           750,  1.6, 14.7,  6.0),
    "passenger_car":     ( 1600,  2.2, 0.30, 1.95, 0.0085,
                           130,  290, 2400, 0.55,
                           12.0,  55, 1.0,   25,     0,
                           800,  1.3, 14.7,  4.0),
}
_P_IDX = {
    "mass_kg": 0, "frontal_m2": 1, "cd": 2, "tire_circ_m": 3, "crr_base": 4,
    "engine_kw": 5, "bsfc_min": 6, "rpm_bsfc_opt": 7, "load_bsfc_opt": 8,
    "therm_mass_kj_c": 9, "batt_ah": 10, "alt_kw": 11, "bearing_C_kn": 12,
    "dpf_cap_g": 13, "rpm_idle": 14, "turbo_pr_max": 15, "stoich_afr": 16,
    "oil_cap_l": 17,
}

def _phys(vehicle_class: np.ndarray, key: str) -> np.ndarray:
    """Vectorized per-class physical parameter lookup."""
    idx = _P_IDX[key]
    classes = list(_PHYS.keys())
    vals = np.array([_PHYS[c][idx] for c in classes])
    code = np.vectorize(VEHICLE_CLASS_CODES.get)(vehicle_class)
    # code order matches class declaration order
    return vals[np.clip(code.astype(int), 0, len(vals) - 1)]

# ── Feature columns ────────────────────────────────────────────────────────────
FEATURE_COLUMNS = [
    # Vehicle identity
    "vehicle_class_code", "protocol_code", "make_code", "powertrain_code",
    "model_year", "odometer_miles", "engine_hours",
    # Drive cycle context
    "drive_cycle_phase_code", "time_since_start_min",
    # Core OBD-II / J1939 sensors (v1-v3)
    "rpm", "engine_temp", "oil_temp", "transmission_temp",
    "fuel_pressure", "fuel_rate", "battery_voltage", "vibration",
    "dpf_soot_load", "brake_temp", "tire_pressure",
    "ambient_temp_c", "elevation_ft",
    # Operational profile
    "payload_ratio", "road_grade_pct", "idle_hours_day",
    "stop_go_ratio", "long_haul_ratio", "towing_ratio",
    "maintenance_neglect", "sensor_missing_rate",
    # 30-day delta features
    "engine_temp_delta_30d", "fuel_pressure_delta_30d",
    "battery_voltage_delta_30d", "vibration_delta_30d",
    "dpf_soot_delta_30d", "brake_temp_delta_30d",
    # v3 engine features
    "egr_flow_rate", "coolant_oil_delta", "maf_throttle_ratio",
    "intake_ambient_delta", "dpf_differential_kpa", "oil_pressure",
    "fuel_trim_short", "fuel_trim_long", "idle_heat_soak",
    "throttle_lag_score", "turbo_boost_kpa", "exhaust_back_pressure",
    "engine_efficiency", "rpm_variance_load_adj", "coolant_temp_oscillation",
    # v4 — atmosphere & aerodynamics
    "air_density_kg_m3",        # ISA: altitude + temp corrected
    "aero_drag_kw",             # 0.5·rho·Cd·A·v³
    "rolling_resistance_kw",    # Crr·m·g·v (tire inflation + surface)
    "road_load_kw",             # total tractive power demand
    "volumetric_efficiency_pct",# charge density vs sea-level reference
    # v4 — combustion & exhaust
    "bsfc_g_per_kwh",           # brake-specific fuel consumption (2-D map)
    "lambda_afr",               # air/fuel lambda (1.0=stoich, <1=rich)
    "egt_c",                    # exhaust gas temperature
    "turbo_outlet_temp_c",      # compressor discharge temperature
    "scr_inlet_temp_c",         # SCR catalyst inlet (DEF efficiency)
    "def_consumption_rate_pct", # DEF as % of fuel (diesel only)
    # v4 — thermal
    "thermal_lag",              # 0-1 distance from steady-state
    "heat_soak_delta_c",        # temp rise after key-off (turbo soak)
    "egr_cooler_fouling",       # thermal resistance buildup (0-1)
    # v4 — oil / lubrication
    "oil_viscosity_cst",        # Walther equation at current oil temp
    "oil_film_thickness_ratio", # Stribeck-based film health (1=full, 0=boundary)
    "oil_tbn",                  # total base number (10=fresh, 0=depleted)
    # v4 — bearing & hub
    "bearing_wear_index",       # L10 life consumed (>1.0 past expected life)
    "bearing_spall_stage",      # 0=healthy 1=early 2=mid 3=severe
    "hub_temp_fl_c", "hub_temp_fr_c", "hub_temp_rl_c", "hub_temp_rr_c",
    # v4 — DPF / emissions
    "dpf_ash_pct",              # cumulative ash (non-regenerable) %
    "dpf_in_regen",             # 1 during active forced regen
    # v4 — battery / electrical
    "battery_soh_pct",          # Arrhenius aging (100=new)
    "battery_soc_pct",          # state of charge
    "alternator_deficit_w",     # electrical load minus alternator output
    "cranking_voltage_v",       # cold-start voltage sag (Peukert + temp)
    # v4 — sensor drift / degradation
    "sensor_coolant_error_c",   # NTC thermistor calibration offset
    "sensor_maf_error_pct",     # MAF hot-wire fouling drift
    "sensor_o2_lag_ms",         # O2 sensor response time degradation
    # Phase 2B — temporal acceleration (d²signal/dt²), matches features.py inference names
    "hubTempFL_accel_h24", "hubTempFR_accel_h24",
    "hubTempRL_accel_h24", "hubTempRR_accel_h24",
    "coolantTemp_accel_h24", "oilTemp_accel_h24",
    "batteryVoltage_accel_h24", "dpfSootLoad_accel_h24",
    "bearingFreqScore_accel_h24", "turboBearingTemp_accel_h24",
]

BASELINE_METRICS = [
    "rpm", "engine_temp", "oil_temp", "transmission_temp",
    "fuel_pressure", "fuel_rate", "battery_voltage", "vibration",
    "dpf_soot_load", "brake_temp", "tire_pressure",
    "oil_pressure", "fuel_trim_long", "dpf_differential_kpa",
    "egt_c", "oil_viscosity_cst", "hub_temp_fl_c", "bearing_wear_index",
]


# ══════════════════════════════════════════════════════════════════════════════
# PHYSICS ENGINE  (all functions fully vectorised — no Python loops)
# ══════════════════════════════════════════════════════════════════════════════

def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(x, -30, 30)))


# ── Atmosphere ─────────────────────────────────────────────────────────────────

def _isa_density(altitude_ft: np.ndarray, temp_c: np.ndarray) -> np.ndarray:
    """Air density (kg/m³) via International Standard Atmosphere."""
    alt_m = altitude_ft * 0.3048
    T_k   = temp_c + 273.15
    P_pa  = 101325.0 * np.where(
        alt_m < 11000,
        (1.0 - 2.2558e-5 * alt_m) ** 5.2559,
        0.22336 * np.exp(-1.5769e-4 * (alt_m - 11000)),
    )
    return P_pa / (287.058 * T_k)


def _charge_density_ratio(rho: np.ndarray) -> np.ndarray:
    """
    Dimensionless air-charge density relative to ISA sea level (ρ / ρ_SL).
    Stored as volumetric_efficiency_pct (× 100) to match column name; represents
    air density available for combustion, NOT engine volumetric efficiency (η_v).
    """
    return np.clip(rho / _RHO_SL, 0.50, 1.05)


# ── Aerodynamics & road loads ──────────────────────────────────────────────────

def _aero_kw(speed_kph: np.ndarray, rho: np.ndarray,
             cd: np.ndarray, area_m2: np.ndarray) -> np.ndarray:
    v = speed_kph / 3.6
    return np.clip(0.5 * rho * cd * area_m2 * v ** 3 / 1000.0, 0, 600)


def _rolling_kw(speed_kph: np.ndarray, mass_kg: np.ndarray,
                crr: np.ndarray) -> np.ndarray:
    v = speed_kph / 3.6
    return np.clip(crr * mass_kg * 9.81 * v / 1000.0, 0, 200)


def _grade_kw(speed_kph: np.ndarray, mass_kg: np.ndarray,
              grade_pct: np.ndarray) -> np.ndarray:
    v    = speed_kph / 3.6
    sinA = np.sin(np.arctan(grade_pct / 100.0))
    return np.clip(mass_kg * 9.81 * sinA * v / 1000.0, -300, 600)


# ── BSFC & combustion ──────────────────────────────────────────────────────────

def _bsfc(rpm: np.ndarray, load_pct: np.ndarray,
          rpm_opt: np.ndarray, bsfc_min: np.ndarray,
          diesel: np.ndarray) -> np.ndarray:
    """
    2-D Gaussian efficiency well in RPM–load space.
    diesel: peak ~195 g/kWh at 1700 RPM, 72% load
    gasoline: peak ~260 g/kWh at 2200 RPM, 65% load
    """
    bsfc_idle = np.where(diesel, 480.0, 550.0)
    rpm_spread  = np.where(diesel, 750.0, 900.0)
    load_spread = np.where(diesel, 0.30, 0.35)
    eff = np.exp(
        -0.5 * ((rpm - rpm_opt) / rpm_spread) ** 2
        - 0.5 * ((load_pct / 100.0 - np.where(diesel, 0.72, 0.65)) / load_spread) ** 2
    )
    return np.clip(bsfc_min + (bsfc_idle - bsfc_min) * (1.0 - eff), bsfc_min, bsfc_idle)


def _fuel_rate_lph(power_kw: np.ndarray, bsfc: np.ndarray,
                   diesel: np.ndarray) -> np.ndarray:
    """Fuel rate (L/h) from shaft power and BSFC."""
    fuel_density = np.where(diesel, 840.0, 750.0)   # g/L
    return np.clip(power_kw * bsfc / fuel_density, 0.3, 130.0)


_RHO_SL = 1.204  # kg/m³ sea-level ISA density (used in training and must match inference)

def _lambda(rho: np.ndarray) -> np.ndarray:
    """
    Air-density ratio as lambda proxy: λ ≈ ρ / ρ_SL.
    λ < 1 at altitude (less air → effectively rich); λ > 1 not physically meaningful
    but capped at 1.05 to suppress ISA rounding.
    Previously fuel_mass_rate * stoich cancelled → (ρ/1.204)² (wrong). Now linear.
    """
    return np.clip(rho / _RHO_SL, 0.70, 1.05)


def _egt(rpm: np.ndarray, load_pct: np.ndarray,
         lambda_: np.ndarray, diesel: np.ndarray) -> np.ndarray:
    """Exhaust gas temperature (°C). Rich mixture and high load raise EGT."""
    base = np.where(diesel, 380.0, 340.0)
    rpm_factor  = 0.040 * np.clip(rpm - 1000, 0, 4000)
    load_factor = np.where(diesel, 2.8, 2.2) * load_pct
    # Rich mixture (lambda < 1) raises EGT sharply; lean lowers it
    lambda_factor = 200.0 * (1.0 - lambda_)
    return np.clip(base + rpm_factor + load_factor + lambda_factor, 150, 950)


def _turbo_outlet_temp(inlet_temp_c: np.ndarray, pr: np.ndarray,
                        eta_c: float = 0.72) -> np.ndarray:
    """
    Compressor discharge temperature via isentropic efficiency.
    T2 = T1 * (1 + (PR^((gamma-1)/gamma) - 1) / eta_c)
    """
    gamma = 1.40
    T1 = inlet_temp_c + 273.15
    T2 = T1 * (1.0 + (np.clip(pr, 1.0, 4.0) ** ((gamma - 1) / gamma) - 1.0) / eta_c)
    return np.clip(T2 - 273.15, inlet_temp_c, 250.0)


def _scr_inlet(egt: np.ndarray, ambient: np.ndarray,
               speed_kph: np.ndarray) -> np.ndarray:
    """SCR catalyst inlet temperature — EGT minus pipe heat loss."""
    # Heat loss increases with speed (more convection) and cold ambient
    loss = np.clip(45.0 + 0.35 * speed_kph - 0.6 * (egt - ambient), 20, 180)
    return np.clip(egt - loss, ambient + 10, 820)


def _def_rate(scr_inlet: np.ndarray, egt: np.ndarray,
              fuel_rate: np.ndarray, diesel: np.ndarray) -> np.ndarray:
    """DEF consumption as % of fuel. Efficiency drops below 200°C."""
    cat_efficiency = np.clip((scr_inlet - 150.0) / 100.0, 0.0, 1.0)
    return np.where(diesel, np.clip(fuel_rate * 0.035 * cat_efficiency, 0, 0.06), 0.0)


# ── Thermal model ──────────────────────────────────────────────────────────────

def _thermal_steady(q_in_kw: np.ndarray, ambient_c: np.ndarray,
                    speed_kph: np.ndarray, thermostat_open: np.ndarray,
                    coolant_loss_pct: np.ndarray) -> np.ndarray:
    """
    Steady-state coolant temperature from Newton's Law of Cooling.
    Q_in = h_eff * A * (T_coolant - T_ambient)
    T_steady = T_ambient + Q_in / h_eff
    h_eff rises sharply when thermostat opens (83°C) and with vehicle speed.
    Coolant loss degrades h_eff (less thermal mass, steam pockets).
    """
    # Effective cooling conductance (kW/°C)
    h_base = np.where(thermostat_open, 0.60, 0.08)
    h_speed = 0.004 * np.clip(speed_kph, 0, 120)   # ram air through radiator
    h_eff   = (h_base + h_speed) * (1.0 - 0.55 * coolant_loss_pct)
    h_eff   = np.maximum(h_eff, 0.02)
    return np.clip(ambient_c + q_in_kw / h_eff, ambient_c, 140.0)


def _thermal_lag(time_min: np.ndarray, therm_mass_kj_c: np.ndarray,
                 h_eff_approx: float = 0.5) -> np.ndarray:
    """
    Fractional distance from thermal equilibrium.
    tau = mass / h_eff [minutes].  lag=1 means still at cold-start temp.
    """
    tau = therm_mass_kj_c / (h_eff_approx * 60.0)   # minutes
    return np.clip(np.exp(-time_min / np.maximum(tau, 1.0)), 0.0, 1.0)


def _heat_soak_delta(q_residual_kw: np.ndarray,
                     therm_mass_kj_c: np.ndarray,
                     turbo_spd_factor: np.ndarray) -> np.ndarray:
    """
    Temperature rise after key-off (no coolant flow).
    Turbo bearing housing spikes 15-50°C above running temp in first 10 min.
    q_residual: stored heat still radiating out (estimated from prior load).
    """
    soak_rise = q_residual_kw * 8.0 / np.maximum(therm_mass_kj_c, 1.0)
    turbo_soak = 22.0 * turbo_spd_factor   # heavier load = bigger turbo soak
    return np.clip(soak_rise + turbo_soak, 0, 65.0)


# ── EGR cooler fouling ─────────────────────────────────────────────────────────

def _egr_cooler_fouling(egr_flow: np.ndarray, egt: np.ndarray,
                         engine_hours: np.ndarray,
                         maintenance_neglect: np.ndarray) -> np.ndarray:
    """
    Thermal resistance fouling index (0=clean, 1=completely fouled).
    Fouling rate ∝ EGR_flow × soot_conc; self-cleaning ∝ EGT above 350°C.
    """
    soot_factor  = np.clip(egr_flow / 30.0, 0, 1.0) * (1.0 + maintenance_neglect)
    clean_factor = np.clip((egt - 350.0) / 200.0, 0, 1.0)
    raw = soot_factor * 0.00003 * engine_hours - clean_factor * 0.000008 * engine_hours
    return np.clip(raw + maintenance_neglect * 0.15, 0.0, 1.0)


# ── Oil & lubrication ──────────────────────────────────────────────────────────

def _walther_viscosity(oil_temp_c: np.ndarray) -> np.ndarray:
    """
    Kinematic viscosity (cSt) via Walther equation for 15W-40 diesel oil.
    Fitted to: 40°C→110 cSt, 100°C→15 cSt, 130°C→8 cSt.
    """
    T_k    = np.clip(oil_temp_c, -30, 200) + 273.15
    log_T  = np.log10(T_k)
    A, B   = 7.949, 3.061
    exponent = A - B * log_T
    # Guard against overflow
    exponent = np.clip(exponent, -2, 3)
    nu = 10.0 ** (10.0 ** exponent) - 0.7
    return np.clip(nu, 1.0, 2000.0)


def _oil_density_arr(oil_temp_c: np.ndarray) -> np.ndarray:
    """SAE 15W-40 mineral density [kg/m³]: ρ(T) = 875 − 0.65·(T−15), clamped [750, 950]."""
    return np.clip(875.0 - 0.65 * (oil_temp_c - 15.0), 750.0, 950.0)


def _oil_film_ratio(
    viscosity_cst: np.ndarray,
    oil_temp_c: np.ndarray,
    rpm: np.ndarray,
    load_pct: np.ndarray,
    wear_index: np.ndarray,
) -> np.ndarray:
    """
    Empirical lubrication-health score (Stribeck/Hersey number proxy).
    Returns 1.0 = full hydrodynamic film, 0.0 = boundary lubrication.

    NOT a physical film-thickness calculation — a normalized dimensionless
    health indicator for SAE 15W-40 engine oil in a journal bearing.

    H = (η · N / P)^0.7  where
        ν  [m²/s]  = viscosity_cst × 1e-6      (kinematic viscosity)
        η  [Pa·s]  = ρ_oil × ν                 (dynamic viscosity)
        N  [rps]   = rpm / 60                   (rotational speed)
        P  [-]     = (load_pct/100) × (1 + wear_index×0.5)

    Oil density: ρ(T) = 875 − 0.65·(T−15) kg/m³ (SAE 15W-40, 0–150 °C, ±15 kg/m³)
    Normalization: H / (H + 0.50)
    Calibration: ≈ 0.656 at 15 cSt / 80 °C / 1800 rpm / 40% load / 0 wear.
    Must match _oil_film_ratio in backend/app/ml/pretrained.py exactly.
    """
    nu      = np.clip(viscosity_cst, 0.1, None) * 1e-6           # kinematic [m²/s]
    rho_oil = _oil_density_arr(oil_temp_c)                        # density [kg/m³]
    eta     = rho_oil * nu                                        # dynamic [Pa·s]
    N       = np.clip(rpm, 1.0, None) / 60.0                     # rotational speed [rps]
    P       = np.clip(load_pct / 100.0, 0.05, 1.0) * (1.0 + np.clip(wear_index, 0, None) * 0.5)
    H       = (eta * N / P) ** 0.7                               # Stribeck proxy
    return np.clip(H / (H + 0.50), 0.0, 1.0)


def _oil_tbn(engine_hours: np.ndarray, oil_temp_c: np.ndarray,
             maintenance_neglect: np.ndarray) -> np.ndarray:
    """
    Total Base Number degradation (Arrhenius).
    TBN_fresh = 10.  Rate doubles every 10°C above 95°C reference.
    Neglected maintenance = longer oil drain intervals = faster depletion.
    """
    T_excess = np.clip(oil_temp_c - 95.0, 0, 50)
    rate = 0.000035 * 2.0 ** (T_excess / 10.0) * (1.0 + maintenance_neglect * 2.0)
    tbn  = 10.0 * np.exp(-rate * engine_hours)
    return np.clip(tbn, 0.0, 10.0)


# ── Bearing physics ────────────────────────────────────────────────────────────

def _l10_hours_field(vehicle_class: np.ndarray, payload_ratio: np.ndarray,
                     grade_pct: np.ndarray, maintenance_neglect: np.ndarray) -> np.ndarray:
    """
    Field-calibrated hub bearing life in hours.
    Based on real fleet data: Class 8 = 400-600K miles to replacement.
    ISO 281 theoretical L10 overpredicts life 5-10× versus field experience due to
    contamination, misalignment, and grease degradation not captured in the formula.
    Load and maintenance adjustments preserve physics-derived relationships.
    """
    # Base field life (hours) — calibrated to fleet replacement intervals.
    # Factor-of-2 increase vs prior values: service intervals target ~0.7 wear_index
    # at end of life (stage 2), with only overheated/neglected trucks reaching stage 3.
    base = np.where(vehicle_class == "heavy_duty_j1939", 26000,
           np.where(vehicle_class == "medium_duty", 17000,
           np.where(vehicle_class == "light_duty_truck", 8000,
           np.where(vehicle_class == "cargo_van", 9000, 5000))))
    # Physics-derived load effect: overloading reduces life, light loads extend it
    load_factor = np.clip(1.0 - (payload_ratio - 0.5) * 0.4 - grade_pct * 0.02, 0.4, 1.3)
    # Maintenance effect: neglect cuts life through contamination & improper greasing
    maint_factor = np.clip(1.0 - maintenance_neglect * 0.55, 0.30, 1.0)
    return np.clip(base * load_factor * maint_factor, 800, 50000)



def _spall_stage(wear_index: np.ndarray) -> np.ndarray:
    """Bearing degradation stage: 0=healthy 1=early 2=mid 3=severe.
    Thresholds calibrated to doubled l10 base values (wear_index≈0.5 at half service life)."""
    return np.where(wear_index >= 1.20, 3,
           np.where(wear_index >= 0.80, 2,
           np.where(wear_index >= 0.45, 1, 0))).astype(float)


def _hub_temps(ambient_c: np.ndarray, speed_kph: np.ndarray,
               load_kn_per_bearing: np.ndarray, wear_index: np.ndarray,
               rng: np.random.Generator, rows: int,
               tire_circ_m: np.ndarray = None) -> tuple:
    """
    Hub bearing temperatures per corner (FL, FR, RL, RR).
    Q_gen = friction_coeff × F_radial × omega × r_bearing
    T_hub = T_ambient + Q_gen / (h_conv × A_surface)
    Worn / spalling bearings have higher friction coefficient.
    """
    r_bearing = 0.065          # m, typical hub bearing radius
    A_surface = 0.04           # m², heat dissipation area
    # Convective heat transfer coefficient rises with vehicle speed
    h_conv    = 8.0 + 0.22 * np.clip(speed_kph, 0, 130)
    # tire_circ_m is circumference (NOT radius); omega = (v_mps / circ_m) * 2π
    circ_m    = tire_circ_m if tire_circ_m is not None else np.full(rows, 3.20)
    # No minimum clamp on rev/s — zero speed means zero rotation, zero friction heat.
    omega     = np.clip(speed_kph / 3.6 / np.maximum(circ_m, 0.5), 0.0, 20.0) * (2 * np.pi)
    # Friction coefficient: healthy ≈ 0.0015, worn ≈ 0.004-0.008, failing ≈ 0.008-0.012
    # Real tapered roller bearing range: 0.001-0.012 depending on condition
    mu_base   = 0.0015 + wear_index * 0.003
    mu_fl     = mu_base * np.clip(1 + rng.normal(0, 0.04, rows), 0.80, 1.30)
    mu_fr     = mu_base * np.clip(1 + rng.normal(0, 0.04, rows), 0.80, 1.30)
    mu_rl     = mu_base * np.clip(1 + rng.normal(0, 0.04, rows), 0.80, 1.30)
    mu_rr     = mu_base * np.clip(1 + rng.normal(0, 0.04, rows), 0.80, 1.30)
    F         = load_kn_per_bearing * 1000.0
    def _t(mu):
        Q_w = mu * F * omega * r_bearing           # watts (friction power)
        return np.clip(ambient_c + Q_w / (h_conv * A_surface), ambient_c, 200.0)
    return _t(mu_fl), _t(mu_fr), _t(mu_rl), _t(mu_rr)


# ── DPF state machine ──────────────────────────────────────────────────────────

def _dpf_state(egt: np.ndarray, load_pct: np.ndarray,
               stop_go: np.ndarray, idle_hrs: np.ndarray,
               maintenance_neglect: np.ndarray, engine_hours: np.ndarray,
               diesel: np.ndarray, rng: np.random.Generator,
               rows: int) -> tuple:
    """
    DPF soot load %, in_regen flag.
    Soot is modeled as a sawtooth cycle (loads up then resets after regen),
    NOT as cumulative accumulation.  This gives a realistic distribution:
      ~40% average soot load, regen triggered at 80%, 5-8% of time in regen.

    Passive regen: EGT > 300°C continuously burns soot (highway cruise).
    Active regen: ECU-forced when soot > 80%; suppresses soot over 20-30 min.
    City / idle / mountain duty produces fastest accumulation.
    """
    # Net soot loading rate (%/hour after passive regen at current conditions)
    passive_rate = np.where(diesel & (egt > 300),
        np.clip((egt - 300.0) / 120.0 * 0.8, 0, 2.0), 0.0)
    load_rate = np.where(diesel,
        np.clip(1.2 + 1.5 * idle_hrs + 1.0 * stop_go + 0.8 * maintenance_neglect
                - passive_rate + rng.normal(0, 0.15, rows), 0.05, 4.0), 0.0)

    # Regen cycle: time between regens = 60% soot capacity / net rate
    # A cycle goes 20%→80% soot then resets. Period = 60 / load_rate hours.
    cycle_period = np.where(diesel, np.clip(60.0 / np.maximum(load_rate, 0.1), 8, 300), 1)
    # Current position in the sawtooth (0=just regenerated, 1=trigger point)
    cycle_phase = (engine_hours % cycle_period) / cycle_period
    soot_load = np.where(diesel, np.clip(20 + 60 * cycle_phase + rng.normal(0, 4, rows), 0, 100), 0)

    # Active regen flag: triggered when soot ≥ 80% (about 5-8% of time)
    in_regen = (soot_load >= 78) & diesel
    # During regen, soot reads lower as it burns
    soot_load = np.where(in_regen, np.clip(soot_load * 0.55, 0, 100), soot_load)
    return soot_load.astype(float), in_regen.astype(float)


# ── Battery / electrical ───────────────────────────────────────────────────────

def _battery_soh(effective_age_years: np.ndarray, avg_temp_c: np.ndarray,
                 idle_hrs_day: np.ndarray) -> np.ndarray:
    """
    Arrhenius aging: degradation rate doubles per 10°C above 25°C baseline.
    Calibrated to real fleet data: lead-acid batteries reach ~65% SOH at 5 years
    in temperate climate → rate_base = 7% per year at 25°C.
    effective_age_years = years since last battery replacement (not vehicle age).
    """
    T_excess   = np.clip(avg_temp_c - 25.0, 0, 50)
    rate_base  = 7.0   # % SOH lost per year at 25°C — calibrated to 5yr field life
    rate       = rate_base * (2.0 ** (T_excess / 10.0)) * (1.0 + idle_hrs_day * 0.06)
    soh        = np.clip(100.0 - rate * effective_age_years, 30.0, 100.0)
    return soh


def _battery_soc(idle_hrs: np.ndarray, long_haul: np.ndarray,
                 stop_go: np.ndarray, battery_soh: np.ndarray) -> np.ndarray:
    """
    Approximate SOC.  Long-haul = high alternator output = near full.
    Extended idle = alternator at low RPM, HVAC running = deficit charging.
    """
    base       = 88.0 + 10.0 * long_haul - 15.0 * idle_hrs - 8.0 * stop_go
    cap_factor = battery_soh / 100.0    # degraded battery can't hold full charge
    soc        = np.clip(base * cap_factor, 20.0, 100.0)
    return soc


def _cranking_voltage(batt_ah: np.ndarray, ambient_c: np.ndarray,
                       soh: np.ndarray, heavy: np.ndarray) -> np.ndarray:
    """
    Cold-start cranking voltage sag (Peukert + Arrhenius internal resistance).
    V_terminal = V_oc - I_crank × R_internal(T, SOH)
    """
    I_crank    = np.where(heavy, 900.0, 420.0)         # Amps
    R_ref      = 0.005 * batt_ah / 100.0               # Ω at 25°C new
    R_age      = R_ref * (1.0 + (1.0 - soh / 100.0) * 2.5)
    R_cold     = R_age * np.exp(-0.020 * (ambient_c - 25.0))  # colder = higher R
    V_oc       = 12.65 * soh / 100.0 + 0.5              # OCV roughly tracks SOH
    V_crank    = V_oc - I_crank * R_cold
    return np.clip(V_crank, 7.5, 14.5)


def _alternator_deficit(rpm: np.ndarray, alt_kw: np.ndarray,
                         idle_hrs: np.ndarray, stop_go: np.ndarray,
                         ambient_c: np.ndarray, heavy: np.ndarray) -> np.ndarray:
    """
    Electrical deficit (W): negative = charging, positive = net drain.
    Alternator output = full at highway RPM, ~55% at idle.
    HVAC load rises with extreme temps; lights + telematics = constant baseline.
    """
    alt_rpm_cutoff = 1400.0
    alt_out_w  = alt_kw * 1000.0 * np.clip(rpm / alt_rpm_cutoff, 0.40, 1.0)
    hvac_load  = np.where(heavy, 2800.0, 1400.0) * np.clip(
        np.abs(ambient_c - 22.0) / 20.0, 0.05, 1.2)
    base_load  = np.where(heavy, 600.0, 350.0)   # telematics, lights, ECU
    total_load = hvac_load + base_load + stop_go * 200.0
    return np.clip(total_load - alt_out_w, -alt_kw * 1000, 3500)


# ── Sensor degradation ─────────────────────────────────────────────────────────

def _sensor_drift(age_years: np.ndarray, vibration: np.ndarray,
                  maintenance_neglect: np.ndarray, long_haul: np.ndarray,
                  rng: np.random.Generator, rows: int) -> tuple:
    """
    Sensor calibration drift from aging, vibration fatigue, and contamination.
    Returns: coolant_error_c, maf_error_pct, o2_lag_ms
    """
    # Coolant NTC thermistor: resistance curve shifts with age + vibration
    coolant_err = (age_years * 0.28 + vibration * 1.2) * rng.choice([-1, 1], rows)
    coolant_err = np.clip(coolant_err + rng.normal(0, 0.4, rows), -8.0, 8.0)
    # MAF hot-wire: oil fouling from catch-can overflow; long-haul self-cleans
    maf_err = np.clip(
        maintenance_neglect * 7.0 + age_years * 0.5 - long_haul * 2.0
        + rng.normal(0, 1.0, rows), -5.0, 18.0)
    # O2 sensor response time: 100ms new, up to 800ms degraded
    o2_lag = np.clip(
        100.0 + age_years * 28.0 + maintenance_neglect * 180.0
        + rng.normal(0, 20.0, rows), 80.0, 850.0)
    return coolant_err, maf_err, o2_lag


# ═══════════════════════════════════════════════════════════════════════════════
# DATA GENERATOR
# ═══════════════════════════════════════════════════════════════════════════════

@dataclass(frozen=True)
class Profile:
    make: str; model: str; vehicle_class: str; protocol: str; powertrain: str
    @property
    def profile_key(self) -> str:
        return f"{self.vehicle_class}:{self.make}:{self.model}".lower().replace(" ", "_")


def generate_mixed_fleet_data(
    fleet_size: int = 10000,
    days: int = 45,
    observations_per_day: int = 1,
    seed: int = 42,
) -> pd.DataFrame:
    """
    Generate physics-informed mixed fleet telemetry.
    Every sensor value is derived from thermodynamic, tribological, and
    electrochemical equations rather than statistical approximations.
    """
    rng  = np.random.default_rng(seed)
    rows = int(fleet_size * days * observations_per_day)
    vehicle_idx = np.repeat(np.arange(fleet_size), days * observations_per_day)
    day_idx     = np.tile(np.repeat(np.arange(days), observations_per_day), fleet_size)

    # ── Vehicle profiles ──────────────────────────────────────────────────────
    profile_choices     = np.array(MAKE_MODEL_PROFILES, dtype=object)
    vp_idx              = rng.choice(len(profile_choices), size=fleet_size, replace=True)
    selected            = profile_choices[vp_idx[vehicle_idx]]
    make, model         = selected[:, 0], selected[:, 1]
    vehicle_class       = selected[:, 2]
    protocol, powertrain = selected[:, 3], selected[:, 4]

    vehicle_class_code  = np.vectorize(VEHICLE_CLASS_CODES.get)(vehicle_class)
    protocol_code       = np.vectorize(PROTOCOL_CODES.get)(protocol)
    make_code           = np.vectorize(MAKE_CODES.get)(make)
    powertrain_code     = np.vectorize(POWERTRAIN_CODES.get)(powertrain)

    model_year  = rng.integers(2014, 2027, size=fleet_size)[vehicle_idx]
    age_years   = np.clip(2026 - model_year, 0, 14).astype(float)
    diesel      = powertrain == "diesel"
    heavy       = vehicle_class == "heavy_duty_j1939"
    medium      = vehicle_class == "medium_duty"
    light       = vehicle_class == "light_duty_truck"
    van         = vehicle_class == "cargo_van"
    car         = vehicle_class == "passenger_car"

    # ── Physical specs (vectorised lookup) ───────────────────────────────────
    mass_kg        = _phys(vehicle_class, "mass_kg")
    frontal_m2     = _phys(vehicle_class, "frontal_m2")
    cd             = _phys(vehicle_class, "cd")
    tire_circ_m    = _phys(vehicle_class, "tire_circ_m")
    crr_base       = _phys(vehicle_class, "crr_base")
    engine_kw      = _phys(vehicle_class, "engine_kw")
    bsfc_min       = _phys(vehicle_class, "bsfc_min")
    rpm_bsfc_opt   = _phys(vehicle_class, "rpm_bsfc_opt")
    therm_mass     = _phys(vehicle_class, "therm_mass_kj_c")
    batt_ah        = _phys(vehicle_class, "batt_ah")
    alt_kw         = _phys(vehicle_class, "alt_kw")
    bearing_C_kn   = _phys(vehicle_class, "bearing_C_kn")
    stoich         = _phys(vehicle_class, "stoich_afr")
    oil_cap_l      = _phys(vehicle_class, "oil_cap_l")

    # ── Environment ──────────────────────────────────────────────────────────
    region = rng.choice(
        ["hot", "cold", "mountain", "temperate", "coastal"], size=rows,
        p=[0.20, 0.20, 0.18, 0.32, 0.10],
    )
    ambient_temp_c = np.select(
        [region == "hot", region == "cold", region == "mountain", region == "coastal"],
        [rng.normal(36, 8, rows), rng.normal(-6, 10, rows),
         rng.normal(8, 10, rows), rng.normal(20, 6, rows)],
        default=rng.normal(18, 9, rows),
    )
    seasonal        = 8.0 * np.sin((day_idx / 365.0) * 2 * np.pi)
    ambient_temp_c  = np.clip(ambient_temp_c + seasonal, -45, 55)

    elevation_ft = np.select(
        [region == "mountain", region == "hot", region == "cold"],
        [rng.normal(6200, 1700, rows), rng.normal(1400, 800, rows), rng.normal(1900, 900, rows)],
        default=rng.normal(900, 650, rows),
    )
    elevation_ft = np.clip(elevation_ft, 0, 12000)

    # ISA air density
    rho            = _isa_density(elevation_ft, ambient_temp_c)
    vol_eff        = _charge_density_ratio(rho)
    air_density_kg = rho

    # ── Operational profile ──────────────────────────────────────────────────
    maintenance_neglect = np.clip(
        rng.beta(1.5, 5.0, fleet_size)[vehicle_idx] + age_years / 40, 0, 1)
    sensor_missing_rate = np.clip(
        rng.beta(1.0, 16.0, rows) + np.where(model_year < 2015, 0.08, 0), 0, 0.42)

    payload_ratio = np.clip(
        np.where(heavy, rng.beta(5.2, 2.1, rows),
        np.where(medium, rng.beta(4.0, 2.4, rows),
        np.where(light | van, rng.beta(3.0, 3.0, rows), rng.beta(1.8, 5.5, rows)))),
        0.05, 1.05)
    stop_go_ratio  = np.clip(np.where(van | car, rng.beta(4.0, 2.4, rows), rng.beta(2.2, 4.0, rows)), 0, 1)
    long_haul_ratio = np.clip(np.where(heavy, rng.beta(4.5, 2.0, rows), rng.beta(1.6, 5.2, rows)), 0, 1)
    towing_ratio   = np.clip(
        np.where(light, rng.beta(1.4, 7.0, rows),
        np.where(heavy | medium, rng.beta(2.2, 4.0, rows), 0)), 0, 1)
    # Centred at 0.5% to give realistic downhill/uphill split (~25% downhill).
    # Mountain regions shift distribution up; range -5.5% to +8.5%.
    road_grade_pct = np.clip(
        rng.normal(0.5, 2.0, rows) + np.where(region == "mountain", 2.0, 0), -5.5, 8.5)
    idle_hours_day = np.clip(
        rng.normal(1.0, 0.6, rows) + np.where(heavy, 0.7, 0)
        + np.where(region == "cold", 0.7, 0) + stop_go_ratio * 0.6, 0, 6)

    odometer_vehicle = rng.uniform(8000, 780000, size=fleet_size)
    odometer_miles   = odometer_vehicle[vehicle_idx] + day_idx * np.where(heavy, 320, np.where(car, 70, 140))
    engine_hours     = np.clip(odometer_miles / np.where(heavy, 38, np.where(car, 31, 27)), 100, 45000)

    # ── Drive cycle phase ────────────────────────────────────────────────────
    phase_roll    = rng.random(rows)
    is_cold_start = phase_roll < (0.06 + stop_go_ratio * 0.04)
    is_warmup     = (phase_roll >= 0.06) & (phase_roll < 0.14)
    is_grade      = (phase_roll >= 0.14) & (phase_roll < (0.14 + road_grade_pct * 0.035 + long_haul_ratio * 0.04))
    is_idle       = ~is_cold_start & ~is_warmup & ~is_grade & (phase_roll > (1.0 - idle_hours_day / 12.0))
    is_heat_soak  = phase_roll > 0.94
    is_city       = stop_go_ratio > 0.55
    is_cruise     = ~is_cold_start & ~is_warmup & ~is_grade & ~is_idle & ~is_heat_soak & (long_haul_ratio > 0.4)

    drive_cycle_phase = np.where(is_cold_start, "cold_start",
                        np.where(is_warmup, "warmup",
                        np.where(is_grade, "grade",
                        np.where(is_idle, "idle",
                        np.where(is_heat_soak, "heat_soak",
                        np.where(is_city, "city", "cruise"))))))
    drive_cycle_phase_code = np.vectorize(DRIVE_CYCLE_CODES.get)(drive_cycle_phase)

    time_since_start_min = np.where(
        is_cold_start, rng.uniform(0, 5, rows),
        np.where(is_warmup, rng.uniform(5, 20, rows),
        np.where(is_heat_soak, rng.uniform(0, 20, rows),
        rng.uniform(20, 480, rows))))

    # ── Vehicle speed by phase ────────────────────────────────────────────────
    speed_kph = np.where(is_cold_start | is_heat_soak, rng.uniform(0, 15, rows),
                np.where(is_idle, rng.uniform(0, 5, rows),
                np.where(is_warmup, rng.uniform(10, 45, rows),
                np.where(is_city, rng.uniform(15, 55, rows),
                np.where(is_grade, rng.uniform(40, 80, rows),
                rng.uniform(70, 115, rows))))))
    speed_kph = np.clip(speed_kph, 0, 130)

    # ── Engine operating point ────────────────────────────────────────────────
    base_rpm  = np.where(heavy, 1180, np.where(medium, 1450, np.where(car, 1900, 1750)))
    rpm = np.where(is_idle | is_heat_soak,
        np.where(heavy, 650, np.where(car, 800, 750)) + rng.normal(0, 30, rows),
        base_rpm + 560 * payload_ratio + 78 * road_grade_pct + 95 * towing_ratio
        + rng.normal(0, np.where(heavy, 85, 160), rows))
    rpm = np.clip(rpm, np.where(heavy, 550, 650), np.where(heavy, 2900, 6200))

    # Engine load % — derived from speed and road conditions
    aero_kw_v  = _aero_kw(speed_kph, rho, cd, frontal_m2)
    roll_kw_v  = _rolling_kw(speed_kph, mass_kg, crr_base * (1.0 + maintenance_neglect * 0.3))
    grade_kw_v = _grade_kw(speed_kph, mass_kg, road_grade_pct)
    # Lower bound is negative engine braking limit, not 0 — downhill grades are valid
    road_load_kw = np.clip(aero_kw_v + roll_kw_v + grade_kw_v, -engine_kw * 0.30, engine_kw * 0.95)
    engine_load_pct = np.clip(road_load_kw / np.maximum(engine_kw, 1.0) * 100.0
                              + rng.normal(0, 4, rows), 5, 98)

    # Turbo boost pressure (kPa above ambient) from pressure ratio
    turbo_pr   = np.clip(1.0 + (engine_load_pct / 100.0) * (_phys(vehicle_class, "turbo_pr_max") - 1.0)
                         * vol_eff - age_years * 0.008 * maintenance_neglect, 1.0, 3.5)
    ambient_kpa = rho * 287.058 * (ambient_temp_c + 273.15) / 1000.0
    turbo_boost_kpa = np.clip((turbo_pr - 1.0) * ambient_kpa, 0, 260)

    # Compressor outlet temperature (intake air heated by compression)
    intake_air_temp = ambient_temp_c + np.where(heavy | medium, 18 + 8 * engine_load_pct / 100, 8)
    turbo_outlet_temp = _turbo_outlet_temp(intake_air_temp, turbo_pr)

    # ── BSFC → fuel rate ─────────────────────────────────────────────────────
    bsfc      = _bsfc(rpm, engine_load_pct, rpm_bsfc_opt, bsfc_min, diesel)
    power_kw_actual = np.clip(road_load_kw + rng.normal(0, 8, rows), 2, engine_kw)
    fuel_rate = _fuel_rate_lph(power_kw_actual, bsfc, diesel) + rng.normal(0, 0.4, rows)
    fuel_rate = np.clip(fuel_rate, 0.3, 120)

    # Fuel system pressure
    fuel_pressure = (np.where(diesel, 63, 51)
                     - 3.2 * np.clip((elevation_ft - 1000) / 5000, 0, 2)
                     - 2.0 * maintenance_neglect
                     + rng.normal(0, 2.2, rows))
    fuel_pressure = np.clip(fuel_pressure, 8, 85)

    # ── Lambda / EGT / SCR chain ──────────────────────────────────────────────
    lambda_afr = _lambda(rho)
    egt_c      = _egt(rpm, engine_load_pct, lambda_afr, diesel)
    # During active regen, EGT spikes to 560-580°C
    scr_inlet  = _scr_inlet(egt_c, ambient_temp_c, speed_kph)
    def_rate   = _def_rate(scr_inlet, egt_c, fuel_rate, diesel)

    # ── Thermal model ────────────────────────────────────────────────────────
    # Combustion heat input: assume ~30% of fuel energy goes to coolant
    fuel_lhv_kwh_l  = np.where(diesel, 9.7, 8.4)
    q_coolant_kw     = fuel_rate * fuel_lhv_kwh_l * 0.30

    # Coolant loss from maintenance neglect (leaks, low level)
    coolant_loss_pct = np.clip(maintenance_neglect * 0.18 + age_years * 0.008, 0, 0.35)
    thermostat_open  = True   # most observations are at operating temp (warmup handled below)

    engine_temp_ss   = _thermal_steady(q_coolant_kw, ambient_temp_c, speed_kph,
                                       thermostat_open, coolant_loss_pct)
    # During cold start and warmup, temperature hasn't reached steady state yet
    therm_lag        = _thermal_lag(time_since_start_min, therm_mass)
    engine_temp      = np.where(
        is_cold_start | is_warmup,
        ambient_temp_c + (engine_temp_ss - ambient_temp_c) * (1.0 - therm_lag),
        engine_temp_ss
    ) + rng.normal(0, 2.5, rows)
    engine_temp      = np.clip(engine_temp + maintenance_neglect * 4.0, ambient_temp_c, 140)

    # Oil runs hotter than coolant (less cooling surface, higher viscosity)
    oil_delta        = np.where(heavy, 11.0, 7.0) + 3.0 * engine_load_pct / 100
    oil_temp         = np.clip(engine_temp + oil_delta + rng.normal(0, 2.0, rows),
                               ambient_temp_c - 5, 155)
    transmission_temp = np.clip(
        70 + 0.006 * rpm + 2.6 * towing_ratio + 2.0 * road_grade_pct
        + 0.22 * ambient_temp_c + rng.normal(0, 3.0, rows), ambient_temp_c, 145)

    # Heat soak: temp rise after key-off (turbo bearings most at risk)
    heat_soak_delta  = _heat_soak_delta(q_coolant_kw * 0.4, therm_mass,
                                         engine_load_pct / 100.0)
    heat_soak_delta  = np.where(is_heat_soak, heat_soak_delta, 0.0)

    # EGR cooler fouling
    egr_flow_rate = np.where(
        diesel,
        np.clip(28 - 0.006 * rpm + 12 * stop_go_ratio - 6 * maintenance_neglect
                + rng.normal(0, 3, rows), 0, 60), 0.0)
    egr_fouling = _egr_cooler_fouling(egr_flow_rate, egt_c, engine_hours,
                                       maintenance_neglect)
    # EGR cooler delta degrades as fouling increases
    egrCoolerDelta_base = np.where(diesel, 35 - 18 * engine_load_pct / 100, 0.0)
    egrCoolerDelta = np.clip(egrCoolerDelta_base * (1.0 - egr_fouling * 0.7)
                             + rng.normal(0, 3, rows), -5, 80)

    # ── Oil physics ───────────────────────────────────────────────────────────
    oil_viscosity  = _walther_viscosity(oil_temp)
    oil_film_ratio = _oil_film_ratio(oil_viscosity, oil_temp, rpm, engine_load_pct,
                                      np.clip(engine_hours / 50000, 0, 2))
    oil_tbn_val    = _oil_tbn(engine_hours, oil_temp, maintenance_neglect)

    # Oil pressure: pump output minus bearing clearance losses
    oil_pressure   = np.clip(
        np.where(heavy, 50 + 0.010 * rpm, 38 + 0.008 * rpm)
        * (oil_viscosity / 80.0) ** 0.3            # viscosity effect
        - 10 * maintenance_neglect - 6 * (age_years / 14)
        + rng.normal(0, 4, rows), 8, 90)

    # ── Bearing wear & hub temperatures ──────────────────────────────────────
    # Fleet operators replace hub bearings on a mileage schedule.
    # Effective wear tracks hours SINCE the last bearing service, not total life.
    service_interval_mi = np.where(heavy, 480000, np.where(medium, 300000, 140000))
    # Well-maintained fleets service more frequently; neglected fleets stretch it
    service_interval_mi = service_interval_mi * np.clip(
        1.0 + (1.0 - maintenance_neglect) * 0.25 - maintenance_neglect * 0.15, 0.50, 1.40)
    miles_since_service = odometer_miles % np.maximum(service_interval_mi, 40000)
    avg_speed_mph       = np.where(heavy, 38, np.where(car, 31, 27))
    engine_hours_bearing = miles_since_service / avg_speed_mph

    l10             = _l10_hours_field(vehicle_class, payload_ratio, road_grade_pct, maintenance_neglect)
    # Temperature above 90°C hub temp accelerates fatigue (grease breakdown)
    temp_factor     = np.clip(1.0 + np.maximum(0, engine_temp - 95) * 0.025, 1.0, 2.5)
    wear_index      = np.clip(engine_hours_bearing / np.maximum(l10, 100) * temp_factor, 0, 3.0)
    spall_stage     = _spall_stage(wear_index)

    load_per_bearing = mass_kg * np.clip(0.14 + payload_ratio * 0.06, 0.10, 0.30) / 1000  # kN

    hub_fl, hub_fr, hub_rl, hub_rr = _hub_temps(
        ambient_temp_c, speed_kph, load_per_bearing, wear_index, rng, rows,
        tire_circ_m=_phys(vehicle_class, "tire_circ_m"))

    # ── DPF state ─────────────────────────────────────────────────────────────
    # Use per-vehicle-class ash capacity for accuracy
    dpf_ash_cap_g   = np.where(heavy, 5000, np.where(medium, 2500, 1000))
    dpf_soot_raw, dpf_in_regen_raw = _dpf_state(
        egt_c, engine_load_pct, stop_go_ratio, idle_hours_day,
        maintenance_neglect, engine_hours, diesel, rng, rows)
    # Override ash capacity per class
    ash_g           = engine_hours * 0.50 * (1.0 + maintenance_neglect * 0.8)
    dpf_ash_pct     = np.where(diesel, np.clip(ash_g / dpf_ash_cap_g * 100, 0, 100), 0)
    dpf_soot_load   = np.where(diesel, dpf_soot_raw, 0.0)
    dpf_in_regen    = np.where(diesel, dpf_in_regen_raw, 0.0)

    # DPF differential pressure (rises with soot + ash)
    dpf_differential_kpa = np.where(diesel, np.clip(
        1.2 + 0.030 * dpf_soot_load + 0.020 * dpf_ash_pct
        + 0.5 * maintenance_neglect + rng.normal(0, 0.5, rows), 0.3, 30.0), 0.0)

    # ── Battery / electrical ──────────────────────────────────────────────────
    # Fleet batteries are replaced every 3-5 years; use effective age since replacement
    batt_repl_interval = np.clip(
        3.5 + (1.0 - maintenance_neglect) * 1.5, 2.0, 6.0)   # 2-6 years
    batt_effective_age = age_years % batt_repl_interval
    battery_soh     = _battery_soh(batt_effective_age, ambient_temp_c, idle_hours_day)
    battery_soc     = _battery_soc(idle_hours_day, long_haul_ratio, stop_go_ratio, battery_soh)
    cranking_v      = _cranking_voltage(batt_ah, ambient_temp_c, battery_soh, heavy)
    alt_deficit     = _alternator_deficit(rpm, alt_kw, idle_hours_day, stop_go_ratio,
                                          ambient_temp_c, heavy)
    battery_voltage = np.clip(
        np.where(is_idle | is_heat_soak,
            cranking_v + 0.2 * battery_soc / 100,
            14.2 - 0.6 * (alt_deficit / 3000.0) - 0.04 * (1 - battery_soh / 100)
        ) + rng.normal(0, 0.18, rows), 7.5, 15.5)

    # ── Sensor drift ─────────────────────────────────────────────────────────
    vibration_scalar = np.clip(
        0.18 + 0.62 * (engine_load_pct / 100) + 0.11 * road_grade_pct
        + 0.10 * towing_ratio + 0.26 * maintenance_neglect
        + spall_stage * 0.15 + rng.normal(0, 0.10, rows), 0, 3.5)
    coolant_err, maf_err, o2_lag = _sensor_drift(
        age_years, vibration_scalar, maintenance_neglect, long_haul_ratio, rng, rows)

    # ── Derived / legacy v3 signals ──────────────────────────────────────────
    wear_progress       = np.clip(day_idx / max(days, 1) + (age_years / 14) * 0.22
                                  + maintenance_neglect * 0.55, 0, 1.8)
    temp_stress         = np.clip((ambient_temp_c - 32) / 18, 0, 2.2) + np.clip((-ambient_temp_c - 6) / 18, 0, 2.2)
    altitude_stress     = np.clip(elevation_ft / 7000, 0, 1.8)
    load_stress         = np.clip((payload_ratio - 0.55) / 0.45, 0, 1.4)

    brake_temp          = np.clip(95 + 24 * stop_go_ratio + 8 * payload_ratio
                                  + 6 * road_grade_pct + 10 * towing_ratio
                                  + rng.normal(0, 8, rows), 60, 420)
    tire_pressure       = np.clip(
        np.where(heavy, 690, np.where(medium, 570, np.where(car, 230, 250)))
        - 20 * (age_years / 14) - 22 * maintenance_neglect
        + rng.normal(0, np.where(heavy, 22, 12), rows), 80, 850)

    throttle_pos        = np.clip(20 + 35 * payload_ratio + 12 * road_grade_pct
                                  + 8 * towing_ratio + rng.normal(0, 6, rows), 5, 100)
    maf_approx          = np.clip(0.12 * rpm * throttle_pos / 100 + rng.normal(0, 8, rows), 1, 350)
    maf_throttle_ratio  = np.clip(maf_approx / np.maximum(throttle_pos, 1.0), 0.3, 5.0)
    intake_ambient_delta = np.clip(turbo_outlet_temp - ambient_temp_c, -5, 80)
    coolant_oil_delta   = oil_temp - engine_temp
    exhaust_back_pressure = np.clip(7 + 0.10 * dpf_soot_load + 0.08 * dpf_ash_pct
                                    + 2.5 * maintenance_neglect + altitude_stress
                                    + rng.normal(0, 1.5, rows), 2, 55)
    engine_efficiency   = np.clip(
        1.0 - bsfc / 600.0 - 0.04 * maintenance_neglect
        - 0.03 * wear_progress + rng.normal(0, 0.03, rows), 0.25, 1.0)
    rpm_variance_load_adj = np.clip(
        70 + 65 * maintenance_neglect + 45 * (age_years / 14)
        + 35 * stop_go_ratio - 25 * long_haul_ratio + rng.normal(0, 20, rows), 5, 450)
    coolant_temp_oscillation = np.clip(
        1.2 + 5.0 * maintenance_neglect * egr_fouling
        + 3.5 * (age_years / 14) + temp_stress * 0.8
        + rng.normal(0, 0.9, rows), 0.3, 22)
    idle_heat_soak      = np.clip(idle_hours_day * 3.8 + maintenance_neglect * 9
                                  + temp_stress * 3.5 + rng.normal(0, 2, rows), 0, 45)
    throttle_lag_score  = np.clip(55 + 90 * maintenance_neglect + 45 * (age_years / 14)
                                  + 20 * stop_go_ratio + rng.normal(0, 15, rows), 10, 350)

    fuel_trim_short     = np.clip(rng.normal(0, 3, rows) + 5 * maintenance_neglect
                                  - 2 * altitude_stress, -25, 25)
    # At altitude, air is thin → engine runs rich → ECU pulls fuel → LTFT negative
    fuel_trim_long      = np.clip(rng.normal(0, 1.5, rows) + 7 * maintenance_neglect
                                  - 4 * altitude_stress + 2 * wear_progress, -25, 25)

    # 30-day deltas
    engine_temp_delta_30d    = 1.0 + 5.2 * wear_progress + 1.6 * temp_stress + rng.normal(0, 1.8, rows)
    fuel_pressure_delta_30d  = -0.5 - 4.0 * wear_progress - 0.9 * altitude_stress + rng.normal(0, 1.4, rows)
    battery_voltage_delta_30d = -0.05 - 0.45 * wear_progress + rng.normal(0, 0.10, rows)
    vibration_delta_30d      = 0.05 + 0.55 * wear_progress + spall_stage * 0.08 + rng.normal(0, 0.09, rows)
    dpf_soot_delta_30d       = np.where(diesel, 1.0 + 18 * wear_progress + 7 * stop_go_ratio + rng.normal(0, 4, rows), 0)
    brake_temp_delta_30d     = 0.8 + 12 * wear_progress + 5 * stop_go_ratio + rng.normal(0, 3, rows)

    # ── SCR efficiency (from scr_inlet) ──────────────────────────────────────
    scr_efficiency = np.clip((scr_inlet - 150.0) / 1.5 + rng.normal(0, 3, rows), 0, 100)

    # ── Phase 2B: Temporal acceleration proxies (d²signal/dt²) ──────────────────
    # All variables are available at this point. Names match features.py inference.

    _hub_accel_base = np.where(
        spall_stage >= 3, 0.28 + 0.45 * np.clip(wear_index - 1.2, 0, 1.5),
        np.where(spall_stage == 2, 0.07 + 0.16 * np.clip(wear_index - 0.80, 0, 0.5),
        np.where(spall_stage == 1, 0.012 + 0.030 * wear_index,
                 np.abs(rng.normal(0, 0.003, rows)))))
    hubTempFL_accel_h24 = np.round(np.clip(_hub_accel_base * rng.uniform(0.82, 1.18, rows) + rng.normal(0, 0.004, rows), -0.08, 1.5), 5)
    hubTempFR_accel_h24 = np.round(np.clip(_hub_accel_base * rng.uniform(0.82, 1.18, rows) + rng.normal(0, 0.004, rows), -0.08, 1.5), 5)
    hubTempRL_accel_h24 = np.round(np.clip(_hub_accel_base * rng.uniform(0.82, 1.18, rows) + rng.normal(0, 0.004, rows), -0.08, 1.5), 5)
    hubTempRR_accel_h24 = np.round(np.clip(_hub_accel_base * rng.uniform(0.82, 1.18, rows) + rng.normal(0, 0.004, rows), -0.08, 1.5), 5)

    coolantTemp_accel_h24 = np.round(np.clip(
        0.005 * np.clip(engine_temp - 95, 0, 40)
        + 0.010 * coolant_loss_pct + 0.007 * maintenance_neglect
        + rng.normal(0, 0.002, rows), -0.04, 0.55), 5)

    oilTemp_accel_h24 = np.round(np.clip(
        0.004 * np.clip(oil_temp - 110, 0, 40) + 0.006 * maintenance_neglect
        + rng.normal(0, 0.0018, rows), -0.03, 0.45), 5)

    batteryVoltage_accel_h24 = np.round(np.clip(
        -0.0011 * np.clip(80 - battery_soh, 0, 50) / 50
        - 0.0016 * (alt_deficit > 1500).astype(float)
        + rng.normal(0, 0.0007, rows), -0.045, 0.01), 5)

    dpfSootLoad_accel_h24 = np.where(
        diesel,
        np.round(np.clip(
            0.09 * stop_go_ratio + 0.11 * maintenance_neglect
            + 0.07 * (dpf_soot_load > 60).astype(float)
            + rng.normal(0, 0.022, rows), -0.35, 1.4), 5),
        0.0)

    bearingFreqScore_accel_h24 = np.round(np.clip(
        _hub_accel_base * 0.22 + rng.normal(0, 0.0018, rows), -0.02, 0.38), 5)

    turboBearingTemp_accel_h24 = np.round(np.clip(
        0.005 * np.clip(egt_c - 580, 0, 320)
        + 0.010 * egr_fouling + 0.007 * maintenance_neglect
        + rng.normal(0, 0.0025, rows), -0.04, 0.75), 5)

    # ── Failure scoring (physics-informed) ───────────────────────────────────
    subsystem_scores = {
        "cooling": (
            -6.0
            + 1.9 * (engine_temp > np.where(heavy, 108, 112))
            + 1.3 * (engine_temp_delta_30d > 7)
            + 0.8 * temp_stress
            + 0.8 * maintenance_neglect
            + 0.7 * (coolant_temp_oscillation > 10)
            + 0.6 * (coolant_loss_pct > 0.20)
        ),
        "charging": (
            -6.2
            + 1.8 * (battery_voltage < 12.2)
            + 1.1 * (battery_voltage_delta_30d < -0.35)
            + 0.7 * idle_hours_day
            + 0.8 * (age_years / 14)
            + 0.5 * (battery_soh < 60)
            + 0.6 * (alt_deficit > 1500)
        ),
        "fuel": (
            -6.4
            + 1.7 * (fuel_pressure < np.where(diesel, 42, 36))
            + 1.0 * (fuel_pressure_delta_30d < -4.0)
            + 0.7 * altitude_stress
            + 0.8 * (np.abs(fuel_trim_long) > 15)
            + 0.5 * (lambda_afr < 0.85)   # rich running = injector/pump issue
        ),
        "dpf_emissions": (
            -7.0
            + 2.1 * (dpf_soot_load > 78)
            + 1.4 * (dpf_soot_delta_30d > 18)
            + 0.9 * stop_go_ratio
            + 0.7 * (dpf_differential_kpa > 14)
            + 0.6 * (dpf_ash_pct > 70)    # high ash = imminent replacement
        ),
        "drivetrain": (
            -6.3
            + 1.3 * (transmission_temp > 110)
            + 1.1 * (vibration_scalar > 1.15)
            + 0.9 * towing_ratio
            + 0.8 * road_grade_pct / 5
            + 0.7 * (spall_stage >= 2)
        ),
        "brakes_tires": (
            -6.0
            + 1.6 * (brake_temp > 145)
            + 1.5 * (tire_pressure < np.where(heavy, 620, 205))
            + 0.9 * stop_go_ratio
        ),
        "engine_wear": (
            -6.1
            + 1.5 * (oil_temp > 124)
            + 1.1 * (rpm > np.where(heavy, 2650, 4300))
            + 1.2 * (age_years / 14)
            + 0.9 * maintenance_neglect
            + 0.7 * (oil_pressure < np.where(heavy, 22, 18))
            + 0.6 * (oil_tbn_val < 2.5)          # depleted oil = wear failure
            + 0.5 * (oil_film_ratio < 0.30)       # boundary lubrication
        ),
        "hub_bearing": (
            -7.2
            + 2.2 * (spall_stage >= 3)          # severe spall — imminent seizure
            + 1.4 * (spall_stage == 2)           # mid-stage — plan replacement
            + 1.2 * (hub_fl > 90)               # very hot — one wheel only triggers partial score
            + 1.0 * (hub_fr > 90)
            + 0.9 * (hub_rl > 90)
            + 0.9 * (hub_rr > 90)
            + 0.8 * (wear_index > 0.90)
            + 0.5 * maintenance_neglect
        ),
        "turbo_exhaust": (
            -6.8
            + 1.8 * (egt_c > 780)
            + 1.4 * (turbo_boost_kpa < 30) * diesel  # boost loss
            + 1.0 * (egr_fouling > 0.70)
            + 0.8 * (scr_efficiency < 60)
            + 0.7 * heat_soak_delta * np.where(is_heat_soak, 1, 0) / 30.0
        ),
    }

    subsystem_prob = {name: _sigmoid(score) for name, score in subsystem_scores.items()}
    risk_score = np.maximum.reduce(list(subsystem_scores.values()))
    failure_probability = _sigmoid((risk_score + 1.05) * 1.45)
    failure_signal = failure_probability + rng.normal(0.0, 0.055, rows)
    failure  = (failure_signal >= 0.46).astype(int)
    sub_keys = np.array(list(subsystem_prob.keys()))
    subsystem = sub_keys[np.argmax(np.vstack(list(subsystem_prob.values())), axis=0)]

    # ── DataFrame ──────────────────────────────────────────────────────────────
    return pd.DataFrame({
        "vehicle_id":            [f"SIM-{i:05d}" for i in vehicle_idx],
        "profile_key":           [Profile(a, b, c, d, e).profile_key
                                  for a, b, c, d, e in zip(make, model, vehicle_class, protocol, powertrain)],
        "make": make, "model": model, "vehicle_class": vehicle_class,
        "protocol": protocol, "powertrain": powertrain,
        # Identity codes
        "vehicle_class_code": vehicle_class_code, "protocol_code": protocol_code,
        "make_code": make_code, "powertrain_code": powertrain_code,
        "model_year": model_year,
        "odometer_miles":        np.round(odometer_miles, 1),
        "engine_hours":          np.round(engine_hours, 1),
        # Drive cycle
        "drive_cycle_phase":     drive_cycle_phase,
        "drive_cycle_phase_code": drive_cycle_phase_code,
        "time_since_start_min":  np.round(time_since_start_min, 1),
        # Core sensors
        "rpm":                   np.round(rpm, 1),
        "engine_temp":           np.round(engine_temp, 2),
        "oil_temp":              np.round(oil_temp, 2),
        "transmission_temp":     np.round(transmission_temp, 2),
        "fuel_pressure":         np.round(fuel_pressure, 2),
        "fuel_rate":             np.round(fuel_rate, 3),
        "battery_voltage":       np.round(battery_voltage, 3),
        "vibration":             np.round(vibration_scalar, 4),
        "dpf_soot_load":         np.round(dpf_soot_load, 2),
        "brake_temp":            np.round(brake_temp, 2),
        "tire_pressure":         np.round(tire_pressure, 2),
        "ambient_temp_c":        np.round(ambient_temp_c, 2),
        "elevation_ft":          np.round(elevation_ft, 1),
        # Operational
        "payload_ratio":         np.round(payload_ratio, 4),
        "road_grade_pct":        np.round(road_grade_pct, 4),
        "idle_hours_day":        np.round(idle_hours_day, 4),
        "stop_go_ratio":         np.round(stop_go_ratio, 4),
        "long_haul_ratio":       np.round(long_haul_ratio, 4),
        "towing_ratio":          np.round(towing_ratio, 4),
        "maintenance_neglect":   np.round(maintenance_neglect, 4),
        "sensor_missing_rate":   np.round(sensor_missing_rate, 4),
        # 30-day deltas
        "engine_temp_delta_30d":    np.round(engine_temp_delta_30d, 4),
        "fuel_pressure_delta_30d":  np.round(fuel_pressure_delta_30d, 4),
        "battery_voltage_delta_30d": np.round(battery_voltage_delta_30d, 4),
        "vibration_delta_30d":      np.round(vibration_delta_30d, 4),
        "dpf_soot_delta_30d":       np.round(dpf_soot_delta_30d, 4),
        "brake_temp_delta_30d":     np.round(brake_temp_delta_30d, 4),
        # v3 engine signals
        "egr_flow_rate":         np.round(egr_flow_rate, 3),
        "coolant_oil_delta":     np.round(coolant_oil_delta, 3),
        "maf_throttle_ratio":    np.round(maf_throttle_ratio, 4),
        "intake_ambient_delta":  np.round(intake_ambient_delta, 3),
        "dpf_differential_kpa": np.round(dpf_differential_kpa, 4),
        "oil_pressure":          np.round(oil_pressure, 2),
        "fuel_trim_short":       np.round(fuel_trim_short, 3),
        "fuel_trim_long":        np.round(fuel_trim_long, 3),
        "idle_heat_soak":        np.round(idle_heat_soak, 3),
        "throttle_lag_score":    np.round(throttle_lag_score, 2),
        "turbo_boost_kpa":       np.round(turbo_boost_kpa, 2),
        "exhaust_back_pressure": np.round(exhaust_back_pressure, 3),
        "engine_efficiency":     np.round(engine_efficiency, 4),
        "rpm_variance_load_adj": np.round(rpm_variance_load_adj, 2),
        "coolant_temp_oscillation": np.round(coolant_temp_oscillation, 4),
        # v4 atmosphere & aerodynamics
        "air_density_kg_m3":     np.round(air_density_kg, 5),
        "aero_drag_kw":          np.round(aero_kw_v, 3),
        "rolling_resistance_kw": np.round(roll_kw_v, 3),
        "road_load_kw":          np.round(road_load_kw, 3),
        "volumetric_efficiency_pct": np.round(vol_eff * 100, 2),
        # v4 combustion & exhaust
        "bsfc_g_per_kwh":        np.round(bsfc, 1),
        "lambda_afr":            np.round(lambda_afr, 4),
        "egt_c":                 np.round(egt_c, 1),
        "turbo_outlet_temp_c":   np.round(turbo_outlet_temp, 1),
        "scr_inlet_temp_c":      np.round(scr_inlet, 1),
        "def_consumption_rate_pct": np.round(def_rate * 100, 3),
        # v4 thermal
        "thermal_lag":           np.round(therm_lag, 4),
        "heat_soak_delta_c":     np.round(heat_soak_delta, 2),
        "egr_cooler_fouling":    np.round(egr_fouling, 4),
        # v4 oil
        "oil_viscosity_cst":     np.round(oil_viscosity, 2),
        "oil_film_thickness_ratio": np.round(oil_film_ratio, 4),
        "oil_tbn":               np.round(oil_tbn_val, 3),
        # v4 bearings
        "bearing_wear_index":    np.round(wear_index, 4),
        "bearing_spall_stage":   spall_stage,
        "hub_temp_fl_c":         np.round(hub_fl, 2),
        "hub_temp_fr_c":         np.round(hub_fr, 2),
        "hub_temp_rl_c":         np.round(hub_rl, 2),
        "hub_temp_rr_c":         np.round(hub_rr, 2),
        # v4 DPF
        "dpf_ash_pct":           np.round(dpf_ash_pct, 2),
        "dpf_in_regen":          dpf_in_regen,
        # v4 electrical
        "battery_soh_pct":       np.round(battery_soh, 2),
        "battery_soc_pct":       np.round(battery_soc, 2),
        "alternator_deficit_w":  np.round(alt_deficit, 1),
        "cranking_voltage_v":    np.round(cranking_v, 3),
        # v4 sensor drift
        "sensor_coolant_error_c": np.round(coolant_err, 3),
        "sensor_maf_error_pct":   np.round(maf_err, 3),
        "sensor_o2_lag_ms":       np.round(o2_lag, 1),
        # Phase 2B — temporal acceleration (names match features.py inference keys)
        "hubTempFL_accel_h24":           hubTempFL_accel_h24,
        "hubTempFR_accel_h24":           hubTempFR_accel_h24,
        "hubTempRL_accel_h24":           hubTempRL_accel_h24,
        "hubTempRR_accel_h24":           hubTempRR_accel_h24,
        "coolantTemp_accel_h24":         coolantTemp_accel_h24,
        "oilTemp_accel_h24":             oilTemp_accel_h24,
        "batteryVoltage_accel_h24":      batteryVoltage_accel_h24,
        "dpfSootLoad_accel_h24":         dpfSootLoad_accel_h24,
        "bearingFreqScore_accel_h24":    bearingFreqScore_accel_h24,
        "turboBearingTemp_accel_h24":    turboBearingTemp_accel_h24,
        # Labels
        "failure":               failure,
        "failure_probability_true": np.round(failure_probability, 6),
        "failure_subsystem":     subsystem,
    })


def generate_heavy_duty_data(
    fleet_size: int = 12,
    days: int = 365,
    observations_per_day: int = 8,
    seed: int = 42,
) -> pd.DataFrame:
    """Backward-compatible helper used by existing evaluation scripts."""
    df = generate_mixed_fleet_data(
        fleet_size=fleet_size, days=days,
        observations_per_day=observations_per_day, seed=seed)
    return df[df["vehicle_class"].eq("heavy_duty_j1939")].copy()


def build_baseline_profiles(df: pd.DataFrame) -> dict:
    profiles = {}
    grouped = df.groupby(
        ["profile_key", "vehicle_class", "make", "model", "protocol", "powertrain"],
        sort=True)
    for (profile_key, vehicle_class, make, model, protocol, powertrain), group in grouped:
        metrics = {}
        for metric in BASELINE_METRICS:
            if metric not in group.columns:
                continue
            values = group[metric].dropna()
            if len(values) == 0:
                continue
            metrics[metric] = {
                "mean": round(float(values.mean()), 6),
                "std":  round(float(values.std(ddof=0)), 6),
                "p10":  round(float(values.quantile(0.10)), 6),
                "p50":  round(float(values.quantile(0.50)), 6),
                "p90":  round(float(values.quantile(0.90)), 6),
            }
        subsystem_counts = group["failure_subsystem"].value_counts(normalize=True).to_dict()
        profiles[profile_key] = {
            "profileKey": profile_key, "vehicleClass": vehicle_class,
            "make": make, "model": model, "protocol": protocol, "powertrain": powertrain,
            "trainingSource": TRAINING_SOURCE, "modelVersion": MODEL_VERSION,
            "sampleCount": int(len(group)),
            "failureRate": round(float(group["failure"].mean()), 6),
            "baselineMetrics": metrics,
            "subsystemPriors": {k: round(float(v), 6) for k, v in subsystem_counts.items()},
        }
    return profiles


def _feature_importances(rf_model, feature_names: list[str], top_n: int = 20) -> list[dict]:
    importances = rf_model.feature_importances_
    pairs = sorted(zip(feature_names, importances), key=lambda x: x[1], reverse=True)
    return [{"feature": f, "importance": round(float(imp), 6)} for f, imp in pairs[:top_n]]


def _train_from_df(df: pd.DataFrame, seed: int = 42, calibrate: bool = False) -> dict:
    """
    Train the RF+HGB ensemble.

    calibrate=True: apply isotonic regression Platt scaling on the validation
    set so output probabilities reflect the real failure base-rate rather than
    the 50/50 training balance.  Use this with natural-proportion training data.
    """
    available_features = [c for c in FEATURE_COLUMNS if c in df.columns]
    X = df[available_features]
    y = df["failure"]

    # Grouped split by vehicle_id prevents same-truck rows leaking across train/test.
    # Falls back to stratified random split when vehicle_id is absent.
    val_frac = 0.25 if calibrate else 0.20
    if "vehicle_id" in df.columns:
        groups = df["vehicle_id"].values
        gss_test = GroupShuffleSplit(n_splits=1, test_size=0.22, random_state=seed)
        dev_idx, test_idx = next(gss_test.split(X, y, groups=groups))
        X_dev, X_test = X.iloc[dev_idx], X.iloc[test_idx]
        y_dev, y_test = y.iloc[dev_idx], y.iloc[test_idx]
        groups_dev = groups[dev_idx]
        gss_val = GroupShuffleSplit(n_splits=1, test_size=val_frac, random_state=seed)
        tr_idx, val_idx = next(gss_val.split(X_dev, y_dev, groups=groups_dev))
        X_train, X_val = X_dev.iloc[tr_idx], X_dev.iloc[val_idx]
        y_train, y_val = y_dev.iloc[tr_idx], y_dev.iloc[val_idx]
    else:
        X_dev, X_test, y_dev, y_test = train_test_split(
            X, y, test_size=0.22, random_state=seed, stratify=y)
        X_train, X_val, y_train, y_val = train_test_split(
            X_dev, y_dev, test_size=val_frac, random_state=seed, stratify=y_dev)

    # Compute balanced sample weights for both RF and HGB.
    # Per-class amplifiers additionally boost cargo_van and medium_duty failures,
    # which cluster below any reasonable threshold at natural base rate (1.67% and 1.97%)
    # even after global balance because their score distributions don't overlap heavy-duty.
    pos_rate = float(y_train.mean())
    neg_rate = 1.0 - pos_rate
    w_pos = 0.5 / max(pos_rate, 1e-6)
    w_neg = 0.5 / max(neg_rate, 1e-6)
    y_arr    = y_train.values
    sample_w = np.where(y_arr == 1, w_pos, w_neg)

    if "vehicle_class_code" in X_train.columns:
        vc = X_train["vehicle_class_code"].values
        _FAIL_BOOST = {
            VEHICLE_CLASS_CODES["cargo_van"]:   5.0,
            VEHICLE_CLASS_CODES["medium_duty"]: 2.0,
        }
        for code, boost in _FAIL_BOOST.items():
            sample_w[(y_arr == 1) & (vc == code)] *= boost

    rf_model = RandomForestClassifier(
        n_estimators=250, max_depth=15, min_samples_leaf=3,
        random_state=seed, n_jobs=-1)
    hgb_model = HistGradientBoostingClassifier(
        max_depth=9, learning_rate=0.045, max_iter=500,
        l2_regularization=0.06, random_state=seed)
    rf_model.fit(X_train, y_train, sample_weight=sample_w)
    hgb_model.fit(X_train, y_train, sample_weight=sample_w)

    # ── Step 1: Per-model isotonic calibrators on first half of val ──────────
    # Fitting on a subset of val prevents the calibrators from overfitting the
    # same data used for ensemble-weight search and ensemble calibration below.
    rf_val_raw   = rf_model.predict_proba(X_val)[:, 1]
    hgb_val_raw  = hgb_model.predict_proba(X_val)[:, 1]
    y_val_arr    = y_val.to_numpy()
    n_half       = len(y_val_arr) // 2

    rf_calibrator = hgb_calibrator = None
    if calibrate:
        rf_calibrator  = IsotonicRegression(out_of_bounds="clip").fit(
            rf_val_raw[:n_half], y_val_arr[:n_half])
        hgb_calibrator = IsotonicRegression(out_of_bounds="clip").fit(
            hgb_val_raw[:n_half], y_val_arr[:n_half])
        print(f"  Per-model calibrators: {n_half:,} val rows  (pos={y_val_arr[:n_half].mean():.3%})")

    # ── Step 2: Apply per-model calibration to full val set ──────────────────
    if calibrate:
        rf_val_cal  = rf_calibrator.predict(rf_val_raw)
        hgb_val_cal = hgb_calibrator.predict(hgb_val_raw)
    else:
        rf_val_cal  = rf_val_raw
        hgb_val_cal = hgb_val_raw

    # ── Step 3: Brier-optimal weight search on second half of val ────────────
    # Weights are chosen to minimize Brier of the calibrated blend, subject to
    # AUC not falling more than 0.001 below the equal-weight baseline.
    rf_ws, hgb_ws, y_ws = rf_val_cal[n_half:], hgb_val_cal[n_half:], y_val_arr[n_half:]
    _ref_blend   = 0.5 * rf_ws + 0.5 * hgb_ws
    _ref_auc     = roc_auc_score(y_ws, _ref_blend) if len(np.unique(y_ws)) > 1 else 0.0
    best_brier_w = float("inf")
    best_rf_w    = 0.30
    for cand_rf_w in np.linspace(0.05, 0.95, 91):
        _blend = cand_rf_w * rf_ws + (1.0 - cand_rf_w) * hgb_ws
        if len(np.unique(y_ws)) < 2:
            continue
        if roc_auc_score(y_ws, _blend) < _ref_auc - 0.001:
            continue
        _b = brier_score_loss(y_ws, _blend)
        if _b < best_brier_w:
            best_brier_w = _b
            best_rf_w    = float(cand_rf_w)
    rf_weight  = best_rf_w
    hgb_weight = 1.0 - rf_weight
    print(f"  Brier-optimal weights:  rf={rf_weight:.2f}  hgb={hgb_weight:.2f}"
          f"  (val-B raw Brier={best_brier_w:.5f})")

    # ── Step 4: Ensemble-level calibrator on full val blended output ─────────
    # Calibrates the blended probability as a unit.  Tries both isotonic and
    # Platt (logistic) scaling and keeps whichever scores lower Brier on val.
    ensemble_calibrator      = None
    ensemble_calibrator_type = "none"
    if calibrate:
        _blend_full = rf_weight * rf_val_cal + hgb_weight * hgb_val_cal
        _iso   = IsotonicRegression(out_of_bounds="clip").fit(_blend_full, y_val_arr)
        _platt = LogisticRegression(C=1e4, solver="lbfgs").fit(
            _blend_full.reshape(-1, 1), y_val_arr)
        _iso_b   = brier_score_loss(y_val_arr, _iso.predict(_blend_full))
        _platt_b = brier_score_loss(
            y_val_arr, _platt.predict_proba(_blend_full.reshape(-1, 1))[:, 1])
        if _iso_b <= _platt_b:
            ensemble_calibrator      = _iso
            ensemble_calibrator_type = "isotonic"
        else:
            ensemble_calibrator      = _platt
            ensemble_calibrator_type = "platt"
        print(f"  Ensemble calibrator: {ensemble_calibrator_type}"
              f"  (isotonic={_iso_b:.5f}  platt={_platt_b:.5f}  on val)")

    # ── Step 5: Full inference pipeline helper ────────────────────────────────
    def _pipeline(rf_raw_p: np.ndarray, hgb_raw_p: np.ndarray) -> np.ndarray:
        """Applies the full production pipeline: per-model cal → blend → ensemble cal."""
        _rf  = rf_calibrator.predict(rf_raw_p)   if rf_calibrator  is not None else rf_raw_p
        _hgb = hgb_calibrator.predict(hgb_raw_p) if hgb_calibrator is not None else hgb_raw_p
        _b   = rf_weight * _rf + hgb_weight * _hgb
        if ensemble_calibrator is None:
            return _b
        if hasattr(ensemble_calibrator, "predict_proba"):
            return ensemble_calibrator.predict_proba(_b.reshape(-1, 1))[:, 1]
        return ensemble_calibrator.predict(_b)

    # ── Step 6: Threshold search on full val through calibrated pipeline ──────
    val_prob_final = _pipeline(rf_val_raw, hgb_val_raw)
    best_thr = None
    best_threshold = 0.32
    for threshold in np.arange(0.10, 0.81, 0.01):
        val_pred  = (val_prob_final >= threshold).astype(int)
        _p  = precision_score(y_val, val_pred, zero_division=0)
        _r  = recall_score(y_val, val_pred, zero_division=0)
        _f1 = f1_score(y_val, val_pred, zero_division=0)
        if _p < 0.55 or _r < 0.45:
            continue
        score = (_f1 + 0.18 * _p + 0.05 * _r, _p, _r)
        if best_thr is None or score > best_thr:
            best_thr = score
            best_threshold = float(threshold)
    if best_thr is None:
        for threshold in np.arange(0.10, 0.91, 0.01):
            val_pred  = (val_prob_final >= threshold).astype(int)
            _p  = precision_score(y_val, val_pred, zero_division=0)
            _r  = recall_score(y_val, val_pred, zero_division=0)
            _f1 = f1_score(y_val, val_pred, zero_division=0)
            if _r < 0.25:
                continue
            score = (_f1 + 0.22 * _p, _p, _r)
            if best_thr is None or score > best_thr:
                best_thr = score
                best_threshold = float(threshold)
    threshold = best_threshold

    # ── Step 7: Test set through full pipeline ────────────────────────────────
    rf_test_raw  = rf_model.predict_proba(X_test)[:, 1]
    hgb_test_raw = hgb_model.predict_proba(X_test)[:, 1]
    test_prob    = _pipeline(rf_test_raw, hgb_test_raw)
    predictions  = (test_prob >= threshold).astype(int)

    thresholds = {
        "balanced":      float(threshold),
        "high_precision": 0.55,
        "high_recall":    0.18,
        "launch_default": float(threshold),
    }

    model_bundle = {
        "model_type": "ensemble",
        "models": {"random_forest": rf_model, "hist_gradient_boosting": hgb_model},
        "calibrators": {"random_forest": rf_calibrator, "hist_gradient_boosting": hgb_calibrator},
        "ensemble_calibrator": ensemble_calibrator,
        "ensemble_calibrator_type": ensemble_calibrator_type,
        "features": available_features,
        "threshold": float(threshold), "thresholds": thresholds,
        "rf_weight": float(rf_weight), "hgb_weight": float(hgb_weight),
        "model_name": "mixed_fleet_rf_hgb_ensemble",
        "model_version": MODEL_VERSION, "training_source": TRAINING_SOURCE,
        "vehicle_class_codes": VEHICLE_CLASS_CODES,
        "protocol_codes": PROTOCOL_CODES,
        "make_codes": MAKE_CODES,
        "powertrain_codes": POWERTRAIN_CODES,
    }

    profiles = build_baseline_profiles(df)

    # ── Per-class metrics + Brier breakdown ──────────────────────────────────
    class_report = {}
    eval_df = X_test.copy()
    eval_df["actual"]    = y_test.to_numpy()
    eval_df["predicted"] = predictions
    eval_df["prob"]      = test_prob
    inverse_class = {v: k for k, v in VEHICLE_CLASS_CODES.items()}
    for class_code, group in eval_df.groupby("vehicle_class_code"):
        actual    = group["actual"]
        predicted = group["predicted"]
        prob      = group["prob"]
        class_report[inverse_class[int(class_code)]] = {
            "rows":        int(len(group)),
            "precision":   round(float(precision_score(actual, predicted, zero_division=0)), 6),
            "recall":      round(float(recall_score(actual, predicted, zero_division=0)), 6),
            "f1":          round(float(f1_score(actual, predicted, zero_division=0)), 6),
            "failureRate": round(float(actual.mean()), 6),
            "brier_score": round(float(brier_score_loss(actual, prob)), 6),
        }

    # ── Holdout through full calibrated pipeline ──────────────────────────────
    holdout_df    = generate_heavy_duty_data(seed=777)
    holdout_feats = [c for c in available_features if c in holdout_df.columns]
    ho_rf_raw  = rf_model.predict_proba(holdout_df[holdout_feats])[:, 1]
    ho_hgb_raw = hgb_model.predict_proba(holdout_df[holdout_feats])[:, 1]
    ho_prob    = _pipeline(ho_rf_raw, ho_hgb_raw)
    ho_pred    = (ho_prob >= threshold).astype(int)
    y_holdout  = holdout_df["failure"].to_numpy()
    holdout_metrics = {
        "rows":        int(len(holdout_df)),
        "accuracy":    round(float(accuracy_score(y_holdout, ho_pred)), 6),
        "precision":   round(float(precision_score(y_holdout, ho_pred, zero_division=0)), 6),
        "recall":      round(float(recall_score(y_holdout, ho_pred, zero_division=0)), 6),
        "f1":          round(float(f1_score(y_holdout, ho_pred, zero_division=0)), 6),
        "roc_auc":     round(float(roc_auc_score(y_holdout, ho_prob)), 6),
        "brier_score": round(float(brier_score_loss(y_holdout, ho_prob)), 6),
        "note":        "heavy_duty seed=777 out-of-sample holdout",
    }

    brier = round(float(brier_score_loss(y_test, test_prob)), 6)
    feature_importance = _feature_importances(rf_model, available_features, top_n=25)

    model_dir = Path(__file__).resolve().parents[1] / "models"
    model_dir.mkdir(parents=True, exist_ok=True)

    metadata = {
        "model_file":      str(model_dir / "fleet_ai_model.pkl"),
        "modelVersion":    MODEL_VERSION,
        "trainingSource":  TRAINING_SOURCE,
        "features":        available_features,
        "featureCount":    len(available_features),
        "rows":            int(len(df)),
        "failure_rate":    round(float(y.mean()), 6),
        "accuracy":        round(float(accuracy_score(y_test, predictions)), 6),
        "precision":       round(float(precision_score(y_test, predictions, zero_division=0)), 6),
        "recall":          round(float(recall_score(y_test, predictions, zero_division=0)), 6),
        "f1":              round(float(f1_score(y_test, predictions, zero_division=0)), 6),
        "roc_auc":         round(float(roc_auc_score(y_test, test_prob)), 6),
        "threshold":       round(float(threshold), 4),
        "thresholds":      {k: round(float(v), 4) for k, v in thresholds.items()},
        "rf_weight":       round(float(rf_weight), 4),
        "hgb_weight":      round(float(hgb_weight), 4),
        "model_name":      "mixed_fleet_rf_hgb_ensemble",
        "vehicle_classes": sorted(VEHICLE_CLASS_CODES.keys()),
        "holdout":         holdout_metrics,
        "featureImportance": feature_importance,
        "brier_score":     brier,
        "physics_engine":  "v4.3 — ISA/aero/BSFC/thermal/Walther/L10/DPF/Peukert/sensor-drift + isotonic calibration + audit fixes",
        "calibrated":      calibrate,
        "notes": (
            "Physics-informed synthetic priors v4.3. "
            "v4.2 audit fixes retained. v4.3 adds: "
            "(5) training/inference vehicle specs unified (mass, engine_kw, Cd, Crr, frontal_m2 now identical); "
            "(6) grade generator produces realistic downhill grades normal(0.5,2.0) clipped to [-5.5,8.5]%; "
            "(7) hub bearing omega floor removed — zero speed produces zero friction heat. "
            "Natural-balance training (8.5% real failure rate) + Platt isotonic calibration. "
            "Bearing life from field-calibrated L10; DPF from sawtooth regen state machine; "
            "battery from Peukert + Arrhenius aging; oil from Walther viscosity equation."
        ),
    }

    joblib.dump(model_bundle, model_dir / "fleet_ai_model.pkl")
    df.to_csv(model_dir / "fleet_ai_synthetic_dataset.csv", index=False)
    (model_dir / "fleet_ai_baseline_profiles.json").write_text(
        json.dumps({"modelVersion": MODEL_VERSION, "profiles": profiles}, indent=2),
        encoding="utf-8")
    (model_dir / "fleet_ai_model_metadata.json").write_text(
        json.dumps(metadata, indent=2), encoding="utf-8")
    (model_dir / "fleet_ai_eval_report.json").write_text(
        json.dumps({"overall": metadata, "holdout": holdout_metrics,
                    "byVehicleClass": class_report,
                    "featureImportance": feature_importance}, indent=2),
        encoding="utf-8")

    print(f"Rows trained:   {len(df):,}")
    print(f"Features used:  {len(available_features)}")
    print(f"Failure rate:   {y.mean():.3%}")
    print(f"Test Precision: {metadata['precision']:.4f}")
    print(f"Test Recall:    {metadata['recall']:.4f}")
    print(f"Test ROC-AUC:   {metadata['roc_auc']:.4f}")
    print(f"Holdout F1:     {holdout_metrics['f1']:.4f}")
    print(f"Holdout AUC:    {holdout_metrics['roc_auc']:.4f}")
    print(f"Top features:   {', '.join(d['feature'] for d in feature_importance[:5])}")
    print(f"Model saved:    {model_dir / 'fleet_ai_model.pkl'}")
    return metadata


def train_and_save_model(
    fleet_size: int = 10000,
    days: int = 45,
    observations_per_day: int = 1,
    seed: int = 42,
) -> None:
    df = generate_mixed_fleet_data(
        fleet_size=fleet_size, days=days,
        observations_per_day=observations_per_day, seed=seed)
    print(f"Single-seed run: fleet_size={fleet_size:,}, days={days}, seed={seed}")
    _train_from_df(df, seed=seed)


def run_multi_seed_training(
    n_seeds: int = 20,
    fleet_size: int = 50000,
    sample_per_seed: int = 10000,
) -> None:
    """
    Multi-seed training for maximum dataset diversity.
    Default (20 seeds × 50K trucks × 10K rows/seed) → 200K diverse rows.
    Full run (200 seeds) → 2M rows from 10M simulated trucks.
    """
    print(f"Multi-seed training: {n_seeds} seeds x {fleet_size:,} trucks, {sample_per_seed:,} rows/seed")
    all_frames: list[pd.DataFrame] = []
    for i in range(n_seeds):
        seed = i
        print(f"  [{i+1:3d}/{n_seeds}] seed={seed} generating {fleet_size:,} trucks... ", end="", flush=True)
        df    = generate_mixed_fleet_data(fleet_size=fleet_size, days=45, seed=seed)
        pos   = df[df["failure"] == 1]
        neg   = df[df["failure"] == 0]
        n_pos = min(len(pos), sample_per_seed // 2)
        n_neg = min(len(neg), sample_per_seed - n_pos)
        rng   = np.random.default_rng(seed + 9999)
        sampled = pd.concat([
            pos.sample(n=n_pos, random_state=int(rng.integers(0, 2**31))),
            neg.sample(n=n_neg, random_state=int(rng.integers(0, 2**31))),
        ])
        print(f"{len(sampled):,} rows (failure={len(pos)/max(len(df),1):.1%})")
        all_frames.append(sampled)
        del df

    df_combined = pd.concat(all_frames, ignore_index=True)
    print(f"\nCombined: {len(df_combined):,} rows across {n_seeds} seeds")
    _train_from_df(df_combined, seed=42)


def run_calibrated_training(
    n_seeds: int = 30,
    fleet_size: int = 50000,
    sample_per_seed: int = 15000,
) -> None:
    """
    Natural-balance + isotonic calibration training.

    Unlike run_multi_seed_training (which uses 50/50 oversampling), this function
    preserves the real fleet failure rate (~8.5%) in the training data so the model
    outputs properly calibrated probabilities.

    Strategy:
      - Sample proportionally (natural 8.5% failure rate, no oversampling)
      - Both RF and HGB receive unified sample_weights: global balance + per-class
        failure amplifiers (cargo_van ×5, medium_duty ×2) to recover recall for
        low-base-rate classes whose score distributions cluster below the threshold
      - After fitting, CalibratedClassifierCV (isotonic) fits on the held-out
        validation set to correct any remaining calibration error

    Default: 30 seeds × 50K trucks × 15K proportional rows → 450K rows at 8.5%
    → ~38K positives for calibration fitting.

    Brier score (perfect = 0.0, baseline = p*(1-p) ≈ 0.078):
      - v4.0 (50/50 balance): typically 0.045-0.060 (poor calibration)
      - v4.1 (calibrated):    targets < 0.010  (well-calibrated)
    """
    print(f"Calibrated training: {n_seeds} seeds x {fleet_size:,} trucks, "
          f"{sample_per_seed:,} proportional rows/seed")
    all_frames: list[pd.DataFrame] = []
    for i in range(n_seeds):
        seed = i + 100  # offset from multi-seed seeds to maximise diversity
        print(f"  [{i+1:3d}/{n_seeds}] seed={seed} generating {fleet_size:,} trucks... ",
              end="", flush=True)
        df  = generate_mixed_fleet_data(fleet_size=fleet_size, days=45, seed=seed)
        nat_rate = df["failure"].mean()
        # Make vehicle_id globally unique across seeds so grouped splits work correctly
        df["vehicle_id"] = f"S{seed}_" + df["vehicle_id"].astype(str)
        # Proportional sample — preserves natural class ratio
        n_sample = min(len(df), sample_per_seed)
        rng = np.random.default_rng(seed + 77777)
        sampled = df.sample(n=n_sample, random_state=int(rng.integers(0, 2**31)))
        print(f"{len(sampled):,} rows (natural failure={nat_rate:.1%})")
        all_frames.append(sampled)
        del df

    df_combined = pd.concat(all_frames, ignore_index=True)
    nat = df_combined["failure"].mean()
    print(f"\nCombined: {len(df_combined):,} rows, natural failure rate={nat:.3%}")
    _train_from_df(df_combined, seed=42, calibrate=True)


def generate_stage2_training_data(
    n_seeds: int = 50,
    fleet_size: int = 50000,
    sample_per_seed: int = 5000,
) -> None:
    """
    Generate labeled data for Stage 2 (confirmatory) classifier training.
    Natural ~0.4% failure rate; injects three FP archetypes:
      sensor_spike, load_stress, prior_artifact.
    """
    STAGE2_FEATURES_LOCAL = [
        "stage1_score", "pretrained_score", "if_score", "welford_score",
        "threshold_score", "dtc_score",
        "w_pretrained", "w_if", "w_welford", "w_threshold", "w_dtc",
        "signal_agreement", "fleet_percentile", "mv_stress_max",
        "sample_count", "welford_confidence", "pretrained_decayed",
        "has_cooling_dtc", "has_fuel_dtc", "has_electrical_dtc",
        "has_emissions_dtc", "has_engine_dtc",
        "diagnosis_urgency", "vehicle_class_code",
        "ambient_temp", "idle_heat_soak", "coolant_temp_oscillation",
        "battery_voltage", "engine_temp_delta_30d",
    ]

    print(f"Stage 2 data: {n_seeds} seeds x {fleet_size:,} trucks, {sample_per_seed:,}/seed")
    all_rows: list[dict] = []

    for i in range(n_seeds):
        seed = i + 1000
        rng  = np.random.default_rng(seed)
        print(f"  [{i+1:3d}/{n_seeds}] seed={seed} ... ", end="", flush=True)
        df = generate_mixed_fleet_data(fleet_size=fleet_size, days=45, seed=seed)
        n_sample = min(len(df), sample_per_seed)
        sampled  = df.sample(n=n_sample, random_state=int(rng.integers(0, 2**31)))

        for _, row in sampled.iterrows():
            true_failure = int(row["failure"])
            failure_prob = float(row.get("failure_probability_true", 0.5 if true_failure else 0.1))

            if true_failure:
                pretrained_s = float(np.clip(rng.normal(failure_prob, 0.06), 0.3, 1.0))
                if_s         = float(np.clip(rng.normal(failure_prob * 0.85, 0.08), 0.25, 1.0))
                welford_s    = float(np.clip(rng.normal(failure_prob * 0.78, 0.09), 0.2, 1.0))
                threshold_s  = float(np.clip(rng.normal(failure_prob * 0.70, 0.10), 0.0, 1.0))
                dtc_s        = float(np.clip(rng.normal(failure_prob * 0.60, 0.12), 0.0, 1.0))
                fp_type, label = "true_positive", 1
            else:
                roll = rng.random()
                if roll < 0.35:
                    base         = float(np.clip(rng.normal(0.15, 0.06), 0.0, 0.34))
                    pretrained_s = float(np.clip(rng.normal(base, 0.04), 0.0, 0.4))
                    if_s         = float(np.clip(rng.normal(base, 0.05), 0.0, 0.4))
                    welford_s    = float(np.clip(rng.normal(base, 0.04), 0.0, 0.4))
                    threshold_s  = float(np.clip(rng.normal(base * 0.6, 0.03), 0.0, 0.3))
                    dtc_s        = 0.0
                    fp_type, label = "true_negative", 0
                elif roll < 0.55:
                    loud = rng.choice(["pretrained", "if", "welford", "threshold"])
                    q    = float(np.clip(rng.normal(0.18, 0.05), 0.05, 0.34))
                    lv   = float(np.clip(rng.normal(0.72, 0.10), 0.50, 0.95))
                    pretrained_s = lv if loud == "pretrained" else q
                    if_s         = lv if loud == "if" else q
                    welford_s    = lv if loud == "welford" else q
                    threshold_s  = lv if loud == "threshold" else q * 0.5
                    dtc_s        = float(np.clip(rng.normal(0.05, 0.03), 0.0, 0.15))
                    fp_type, label = "sensor_spike", 0
                elif roll < 0.75:
                    base         = float(np.clip(rng.normal(0.42, 0.05), 0.36, 0.58))
                    pretrained_s = float(np.clip(rng.normal(base, 0.04), 0.3, 0.65))
                    if_s         = float(np.clip(rng.normal(base * 0.90, 0.05), 0.25, 0.65))
                    welford_s    = float(np.clip(rng.normal(base * 0.85, 0.05), 0.2, 0.60))
                    threshold_s  = float(np.clip(rng.normal(base * 0.70, 0.05), 0.1, 0.55))
                    dtc_s        = float(np.clip(rng.normal(0.10, 0.06), 0.0, 0.25))
                    fp_type, label = "load_stress", 0
                else:
                    pretrained_s = float(np.clip(rng.normal(0.68, 0.08), 0.50, 0.90))
                    if_s         = float(np.clip(rng.normal(0.18, 0.06), 0.05, 0.35))
                    welford_s    = float(np.clip(rng.normal(0.14, 0.05), 0.05, 0.30))
                    threshold_s  = float(np.clip(rng.normal(0.10, 0.04), 0.0, 0.25))
                    dtc_s        = float(np.clip(rng.normal(0.04, 0.03), 0.0, 0.15))
                    fp_type, label = "prior_artifact", 0

            sample_count = int(rng.integers(5, 2001))
            pt_trust = max(0.0, min(1.0, 1.0 - (sample_count - 50) / 450)) if sample_count > 50 else 1.0
            w_pt = 0.20 * pt_trust
            w_if = 0.30
            missing = 0.20 - w_pt
            live_factor = (0.50 + missing) / 0.50
            w_w  = 0.30 * live_factor
            w_t  = 0.12 * live_factor
            w_d  = 0.08 * live_factor
            stage1_score = min(1.0, w_pt * pretrained_s + w_if * if_s
                               + w_w * welford_s + w_t * threshold_s + w_d * dtc_s)

            raw_sc  = [pretrained_s, if_s, welford_s, threshold_s, dtc_s]
            mean_s  = sum(raw_sc) / 5
            std_s   = (sum((s - mean_s) ** 2 for s in raw_sc) / 5) ** 0.5
            cv      = std_s / max(mean_s, 1e-9)
            signal_agreement = float(max(0.0, min(1.0, 1.0 - cv)))

            vc = str(row.get("vehicle_class", "light_duty_truck"))
            class_code_map = {"passenger_car": 0, "light_duty_truck": 1,
                               "cargo_van": 2, "medium_duty": 3, "heavy_duty_j1939": 4}
            vehicle_class_code = float(class_code_map.get(vc, 1))

            if stage1_score < 0.35 and fp_type == "true_negative":
                continue

            all_rows.append({
                "stage1_score":      round(stage1_score, 4),
                "pretrained_score":  round(pretrained_s, 4),
                "if_score":          round(if_s, 4),
                "welford_score":     round(welford_s, 4),
                "threshold_score":   round(threshold_s, 4),
                "dtc_score":         round(dtc_s, 4),
                "w_pretrained":      round(w_pt, 4),
                "w_if":              round(w_if, 4),
                "w_welford":         round(w_w, 4),
                "w_threshold":       round(w_t, 4),
                "w_dtc":             round(w_d, 4),
                "signal_agreement":  round(signal_agreement, 4),
                "fleet_percentile":  round(float(rng.uniform(0.1, 0.9)), 4),
                "mv_stress_max":     round(float(np.clip(rng.normal(stage1_score * 0.6, 0.1), 0, 1)), 4),
                "sample_count":      sample_count,
                "welford_confidence": round(float(min(1.0, rng.integers(5, 201) / 100)), 4),
                "pretrained_decayed": round(float(1.0 - pt_trust), 4),
                "has_cooling_dtc":   float(rng.random() < 0.10 * stage1_score),
                "has_fuel_dtc":      float(rng.random() < 0.08 * stage1_score),
                "has_electrical_dtc": float(rng.random() < 0.07 * stage1_score),
                "has_emissions_dtc": float(rng.random() < 0.09 * stage1_score),
                "has_engine_dtc":    float(rng.random() < 0.06 * stage1_score),
                "diagnosis_urgency": round(float(np.clip(rng.normal(stage1_score * 0.7, 0.12), 0, 1)) if label else 0.0, 4),
                "vehicle_class_code": vehicle_class_code,
                "ambient_temp":       round(float(row.get("ambient_temp_c", 20.0)), 2),
                "idle_heat_soak":     round(float(row.get("idle_heat_soak", 0.0)), 3),
                "coolant_temp_oscillation": round(float(row.get("coolant_temp_oscillation", 0.0)), 3),
                "battery_voltage":    round(float(row.get("battery_voltage", 12.6)), 3),
                "engine_temp_delta_30d": round(float(row.get("engine_temp_delta_30d", 0.0)), 3),
                "label": label,
                "fp_type": fp_type,
            })

        pos_rate = sum(r["label"] for r in all_rows[-n_sample:]) / max(n_sample, 1)
        print(f"{len(all_rows):,} total rows (failure={pos_rate:.2%})")
        del df

    out_df    = pd.DataFrame(all_rows)
    model_dir = Path(__file__).resolve().parents[1] / "models"
    model_dir.mkdir(parents=True, exist_ok=True)
    out_path  = model_dir / "fleet_ai_stage2_training.parquet"
    out_df.to_parquet(out_path, index=False)
    total, pos = len(out_df), int(out_df["label"].sum())
    print(f"\nStage 2: {total:,} rows, {pos:,} positives ({pos/total:.2%})")
    print(f"FP types: {out_df['fp_type'].value_counts().to_dict()}")
    print(f"Saved: {out_path}")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Fleet AI physics-informed simulation v4.")
    p.add_argument("--fleet-size",    type=int, default=10000)
    p.add_argument("--days",          type=int, default=45)
    p.add_argument("--observations-per-day", type=int, default=1)
    p.add_argument("--seed",          type=int, default=42)
    p.add_argument("--multi-seed",    action="store_true")
    p.add_argument("--n-seeds",       type=int, default=20)
    p.add_argument("--sample-per-seed", type=int, default=10000)
    p.add_argument("--full",          action="store_true", help="200 seeds (2M rows)")
    p.add_argument("--calibrated",    action="store_true",
                   help="Natural-balance + isotonic calibration (30 seeds, recommended)")
    p.add_argument("--stage2-data",   action="store_true")
    p.add_argument("--stage2-n-seeds", type=int, default=50)
    p.add_argument("--stage2-sample-per-seed", type=int, default=5000)
    return p.parse_args()


if __name__ == "__main__":
    args = parse_args()
    if args.stage2_data:
        generate_stage2_training_data(
            n_seeds=args.stage2_n_seeds,
            fleet_size=args.fleet_size,
            sample_per_seed=args.stage2_sample_per_seed,
        )
    elif args.calibrated:
        run_calibrated_training(
            n_seeds=args.n_seeds if args.n_seeds != 20 else 30,
            fleet_size=args.fleet_size,
            sample_per_seed=args.sample_per_seed if args.sample_per_seed != 10000 else 15000,
        )
    elif args.multi_seed or args.full:
        run_multi_seed_training(
            n_seeds=200 if args.full else args.n_seeds,
            fleet_size=args.fleet_size,
            sample_per_seed=args.sample_per_seed,
        )
    else:
        train_and_save_model(
            fleet_size=args.fleet_size,
            days=args.days,
            observations_per_day=args.observations_per_day,
            seed=args.seed,
        )
