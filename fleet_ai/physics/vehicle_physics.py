"""
Fleet AI — Canonical Vehicle Physics Registry
=============================================
Single source of truth for per-class vehicle physical parameters.

Both fleet_simulation.py (training) and pretrained.py (inference) import
from this module. Changing a value here propagates to both automatically;
comments saying "must match" in separate tables are no longer needed.

Unit contract
-------------
mass_kg       kg       gross vehicle weight (fully loaded)
frontal_m2    m²       frontal area for aerodynamic drag
cd            -        aerodynamic drag coefficient
tire_circ_m   m        CIRCUMFERENCE (not radius); omega = (v_mps/circ)*2π
crr_base      -        base rolling-resistance coefficient
engine_kw     kW       peak rated engine power
alt_kw        kW       alternator output capacity
dpf           bool     diesel particulate filter present
bsfc_min      g/kWh    minimum brake-specific fuel consumption
rpm_bsfc_opt  rpm      RPM at peak BSFC efficiency
load_bsfc_opt -        load fraction at peak BSFC efficiency (0–1)
therm_mass    kJ/°C    engine thermal mass
batt_ah       Ah       battery capacity
bearing_C_kn  kN       basic dynamic bearing load rating
dpf_cap_g     g        DPF ash capacity (0 = no DPF)
rpm_idle      rpm      warm idle RPM
turbo_pr_max  -        maximum turbocharger pressure ratio
stoich_afr    -        stoichiometric air-fuel ratio
oil_cap_l     L        engine oil capacity
"""
from __future__ import annotations

# ── Canonical registry ────────────────────────────────────────────────────────
# Keys must match VEHICLE_CLASS_CODES order (used for positional tuple lookup).
VEHICLE_SPECS: dict[str, dict] = {
    "heavy_duty_j1939": {
        "mass_kg":       36000,
        "frontal_m2":    9.4,
        "cd":            0.60,
        "tire_circ_m":   3.20,
        "crr_base":      0.0065,
        "engine_kw":     450,
        "bsfc_min":      195,
        "rpm_bsfc_opt":  1700,
        "load_bsfc_opt": 0.72,
        "therm_mass":    95.0,
        "batt_ah":       200,
        "alt_kw":        3.5,
        "bearing_C_kn":  380,
        "dpf_cap_g":     7000,
        "rpm_idle":      650,
        "turbo_pr_max":  3.2,
        "stoich_afr":    14.5,
        "oil_cap_l":     38.0,
        "dpf":           True,
    },
    "medium_duty": {
        "mass_kg":       12000,
        "frontal_m2":    6.8,
        "cd":            0.65,
        "tire_circ_m":   2.90,
        "crr_base":      0.0070,
        "engine_kw":     200,
        "bsfc_min":      210,
        "rpm_bsfc_opt":  1600,
        "load_bsfc_opt": 0.70,
        "therm_mass":    55.0,
        "batt_ah":       110,
        "alt_kw":        2.2,
        "bearing_C_kn":  180,
        "dpf_cap_g":     3500,
        "rpm_idle":      700,
        "turbo_pr_max":  2.8,
        "stoich_afr":    14.5,
        "oil_cap_l":     15.0,
        "dpf":           True,
    },
    "light_duty_truck": {
        "mass_kg":       3800,
        "frontal_m2":    3.3,
        "cd":            0.45,
        "tire_circ_m":   2.20,
        "crr_base":      0.0080,
        "engine_kw":     290,
        "bsfc_min":      260,
        "rpm_bsfc_opt":  2200,
        "load_bsfc_opt": 0.65,
        "therm_mass":    22.0,
        "batt_ah":       70,
        "alt_kw":        1.4,
        "bearing_C_kn":  50,
        "dpf_cap_g":     0,
        "rpm_idle":      750,
        "turbo_pr_max":  1.5,
        "stoich_afr":    14.7,
        "oil_cap_l":     6.0,
        "dpf":           False,
    },
    "cargo_van": {
        "mass_kg":       4500,
        "frontal_m2":    4.2,
        "cd":            0.52,
        "tire_circ_m":   2.30,
        "crr_base":      0.0078,
        "engine_kw":     220,
        "bsfc_min":      270,
        "rpm_bsfc_opt":  2000,
        "load_bsfc_opt": 0.62,
        "therm_mass":    24.0,
        "batt_ah":       75,
        "alt_kw":        1.6,
        "bearing_C_kn":  55,
        "dpf_cap_g":     0,
        "rpm_idle":      750,
        "turbo_pr_max":  1.6,
        "stoich_afr":    14.7,
        "oil_cap_l":     6.0,
        "dpf":           False,
    },
    "passenger_car": {
        "mass_kg":       1600,
        "frontal_m2":    2.2,
        "cd":            0.30,
        "tire_circ_m":   1.95,
        "crr_base":      0.0085,
        "engine_kw":     130,
        "bsfc_min":      290,
        "rpm_bsfc_opt":  2400,
        "load_bsfc_opt": 0.55,
        "therm_mass":    12.0,
        "batt_ah":       55,
        "alt_kw":        1.0,
        "bearing_C_kn":  25,
        "dpf_cap_g":     0,
        "rpm_idle":      800,
        "turbo_pr_max":  1.3,
        "stoich_afr":    14.7,
        "oil_cap_l":     4.0,
        "dpf":           False,
    },
}

# Ordered key list that matches the tuple positions in fleet_simulation._PHYS.
# Training builds _PHYS tuples from this order via build_phys_tuple().
PHYS_KEY_ORDER: list[str] = [
    "mass_kg", "frontal_m2", "cd", "tire_circ_m", "crr_base",
    "engine_kw", "bsfc_min", "rpm_bsfc_opt", "load_bsfc_opt",
    "therm_mass", "batt_ah", "alt_kw", "bearing_C_kn", "dpf_cap_g",
    "rpm_idle", "turbo_pr_max", "stoich_afr", "oil_cap_l",
]

# Class name → integer code (must match VEHICLE_CLASS_CODES in fleet_simulation)
CLASS_CODES: dict[str, int] = {
    "heavy_duty_j1939": 0,
    "medium_duty":      1,
    "light_duty_truck": 2,
    "cargo_van":        3,
    "passenger_car":    4,
}


def build_phys_tuple(class_name: str) -> tuple:
    """Return the physics parameter tuple for fleet_simulation._PHYS."""
    specs = VEHICLE_SPECS[class_name]
    return tuple(specs[k] for k in PHYS_KEY_ORDER)


def inference_specs(class_code: int) -> dict:
    """Return the physics spec dict for pretrained.py _PHYS_SPECS keyed by class code."""
    name = next(n for n, c in CLASS_CODES.items() if c == class_code)
    s = VEHICLE_SPECS[name]
    return {
        "mass":        s["mass_kg"],
        "A":           s["frontal_m2"],
        "Cd":          s["cd"],
        "Crr":         s["crr_base"],
        "eng_kw":      s["engine_kw"],
        "alt_kw":      s["alt_kw"],
        "dpf":         s["dpf"],
        "tire_circ_m": s["tire_circ_m"],
    }
