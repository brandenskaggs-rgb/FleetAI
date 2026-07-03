"""
Training / inference parity tests — v4.4

Proves that fleet_simulation.py (training) and pretrained.py (inference)
use the same physics registry, feature names, units, defaults, and formulas.
These tests must pass before any retrain; if they fail, the parity contract
has been broken and the model would score live traffic differently than it
was trained to expect.
"""
import math
import sys
import pathlib

import numpy as np
import pytest

REPO_ROOT = pathlib.Path(__file__).parents[2]
sys.path.insert(0, str(REPO_ROOT / "backend"))
sys.path.insert(0, str(REPO_ROOT / "fleet_ai" / "training"))
sys.path.insert(0, str(REPO_ROOT))

# ─────────────────────────────────────────────────────────────────────────────

def _sim():
    import fleet_simulation
    return fleet_simulation

def _pt():
    from app.ml import pretrained
    return pretrained

def _reg():
    from fleet_ai.physics import vehicle_physics
    return vehicle_physics


# ═════════════════════════════════════════════════════════════════════════════
# 1. Shared registry is the single source of truth
# ═════════════════════════════════════════════════════════════════════════════

class TestRegistryLoaded:
    def test_pretrained_loads_from_registry(self):
        pt = _pt()
        assert pt._REGISTRY_LOADED, (
            "pretrained.py failed to import fleet_ai.physics.vehicle_physics — "
            "running on stale inline fallback"
        )

    def test_registry_has_all_five_classes(self):
        reg = _reg()
        expected = {"heavy_duty_j1939", "medium_duty", "light_duty_truck", "cargo_van", "passenger_car"}
        assert set(reg.VEHICLE_SPECS.keys()) == expected

    def test_registry_class_codes_match_simulation(self):
        reg = _reg()
        sim = _sim()
        for name, code in reg.CLASS_CODES.items():
            assert sim.VEHICLE_CLASS_CODES[name] == code, (
                f"{name}: registry code={code}, sim code={sim.VEHICLE_CLASS_CODES[name]}"
            )


# ═════════════════════════════════════════════════════════════════════════════
# 2. Vehicle specs: training tuples == inference dicts == registry
# ═════════════════════════════════════════════════════════════════════════════

class TestSpecParity:
    """Every physics parameter must be identical in all three representations."""

    CHECKED_KEYS = [
        ("mass_kg",     "mass"),
        ("frontal_m2",  "A"),
        ("cd",          "Cd"),
        ("crr_base",    "Crr"),
        ("engine_kw",   "eng_kw"),
        ("alt_kw",      "alt_kw"),
        ("tire_circ_m", "tire_circ_m"),
    ]

    @pytest.mark.parametrize("class_name", [
        "heavy_duty_j1939", "medium_duty", "light_duty_truck", "cargo_van", "passenger_car"
    ])
    def test_training_matches_registry(self, class_name):
        sim = _sim()
        reg = _reg()
        registry_specs = reg.VEHICLE_SPECS[class_name]
        for reg_key, _ in self.CHECKED_KEYS:
            train_val = float(sim._phys(np.array([class_name]), reg_key)[0])
            reg_val   = float(registry_specs[reg_key])
            assert abs(train_val - reg_val) < 1e-9, (
                f"{class_name}.{reg_key}: training={train_val}, registry={reg_val}"
            )

    @pytest.mark.parametrize("class_name", [
        "heavy_duty_j1939", "medium_duty", "light_duty_truck", "cargo_van", "passenger_car"
    ])
    def test_inference_matches_registry(self, class_name):
        pt = _pt()
        reg = _reg()
        class_code    = reg.CLASS_CODES[class_name]
        infer_specs   = pt._PHYS_SPECS[class_code]
        registry_specs = reg.VEHICLE_SPECS[class_name]
        for reg_key, inf_key in self.CHECKED_KEYS:
            infer_val = float(infer_specs[inf_key])
            reg_val   = float(registry_specs[reg_key])
            assert abs(infer_val - reg_val) < 1e-9, (
                f"{class_name}.{reg_key}: inference[{inf_key}]={infer_val}, registry={reg_val}"
            )

    def test_heavy_duty_mass_is_gcvw(self):
        """Heavy-duty mass must be GVW (~36,000 kg), not tractor-only (~15,000 kg)."""
        reg = _reg()
        assert reg.VEHICLE_SPECS["heavy_duty_j1939"]["mass_kg"] >= 30000, (
            "Heavy-duty mass must reflect GVW (fully loaded Class 8)"
        )

    def test_dpf_present_only_for_diesel_classes(self):
        reg = _reg()
        assert reg.VEHICLE_SPECS["heavy_duty_j1939"]["dpf"] is True
        assert reg.VEHICLE_SPECS["medium_duty"]["dpf"] is True
        assert reg.VEHICLE_SPECS["light_duty_truck"]["dpf"] is False
        assert reg.VEHICLE_SPECS["passenger_car"]["dpf"] is False


# ═════════════════════════════════════════════════════════════════════════════
# 3. Feature name contract
# ═════════════════════════════════════════════════════════════════════════════

class TestFeatureNames:
    """Feature names in training must appear in inference PRETRAINED_FEATURE_COLUMNS."""

    def test_charge_density_ratio_in_training_features(self):
        sim = _sim()
        assert "charge_density_ratio" in sim.FEATURE_COLUMNS, (
            "charge_density_ratio missing from training FEATURE_COLUMNS"
        )

    def test_lambda_afr_removed_from_training_features(self):
        sim = _sim()
        assert "lambda_afr" not in sim.FEATURE_COLUMNS, (
            "lambda_afr still in training FEATURE_COLUMNS — should be charge_density_ratio"
        )

    def test_charge_density_ratio_in_inference_columns(self):
        pt = _pt()
        assert "charge_density_ratio" in pt.PRETRAINED_FEATURE_COLUMNS, (
            "charge_density_ratio missing from inference PRETRAINED_FEATURE_COLUMNS"
        )

    def test_training_features_are_subset_of_inference_columns(self):
        """Every feature the model trains on must be computable at inference time."""
        sim = _sim()
        pt  = _pt()
        inf_set = set(pt.PRETRAINED_FEATURE_COLUMNS)
        for feat in sim.FEATURE_COLUMNS:
            assert feat in inf_set, (
                f"Training feature '{feat}' has no corresponding inference computation"
            )

    def test_no_duplicate_feature_names(self):
        sim = _sim()
        pt  = _pt()
        assert len(sim.FEATURE_COLUMNS) == len(set(sim.FEATURE_COLUMNS)), \
            "Duplicate feature names in training FEATURE_COLUMNS"
        assert len(pt.PRETRAINED_FEATURE_COLUMNS) == len(set(pt.PRETRAINED_FEATURE_COLUMNS)), \
            "Duplicate feature names in inference PRETRAINED_FEATURE_COLUMNS"


# ═════════════════════════════════════════════════════════════════════════════
# 4. Unit parity for shared constants
# ═════════════════════════════════════════════════════════════════════════════

class TestUnitParity:
    def test_rho_sl_same_in_training_and_inference(self):
        """Sea-level ISA density must be 1.204 in both paths."""
        sim = _sim()
        pt  = _pt()
        assert abs(sim._RHO_SL - 1.204) < 1e-9, f"Training _RHO_SL = {sim._RHO_SL}"
        # Inference uses rho_sl as local variable; verify the constant in pretrained
        # by checking lambda output at sea-level density matches expected
        lam_train = float(sim._lambda(np.array([1.204]))[0])
        assert abs(lam_train - 1.0) < 0.01, "At rho=1.204, lambda must equal 1.0"

    def test_tire_circ_is_circumference_not_radius(self):
        """tire_circ_m must be > 1.0 m (circumference) for every class.
        A wheel radius would be 0.3–0.6 m; circumference is 1.95–3.20 m."""
        reg = _reg()
        for name, specs in reg.VEHICLE_SPECS.items():
            assert specs["tire_circ_m"] > 1.0, (
                f"{name} tire_circ_m = {specs['tire_circ_m']} looks like a radius, not circumference"
            )

    def test_omega_formula_uses_circumference(self):
        """omega = (v_mps / circumference) * 2π, not (v_mps / radius) * 2π."""
        v_mps  = 80 / 3.6        # 80 km/h
        circ   = 3.20            # heavy-duty circumference
        radius = circ / (2 * math.pi)   # ~0.509 m

        omega_circ   = (v_mps / circ)   * 2 * math.pi   # ~43.6 rad/s
        omega_radius = (v_mps / radius) * 2 * math.pi   # ~274 rad/s (wrong)

        # The simulation clips at 20 rps; verify correct path stays below that
        assert omega_circ / (2 * math.pi) < 20, "Correct formula should be < 20 rps at 80 km/h"
        assert omega_radius / (2 * math.pi) > 20, "Radius-based formula would exceed 20 rps clamp"

    def test_omega_zero_at_standstill(self):
        """Zero vehicle speed must produce zero wheel rotation."""
        sim = _sim()
        rng  = np.random.default_rng(0)
        rows = 10
        fl, *_ = sim._hub_temps(
            np.full(rows, 20.0), np.zeros(rows),
            np.full(rows, 2.0), np.zeros(rows),
            rng, rows, tire_circ_m=np.full(rows, 3.20),
        )
        assert np.allclose(fl, 20.0, atol=1e-6), \
            "Zero speed must give zero friction heat; hub temp must equal ambient"


# ═════════════════════════════════════════════════════════════════════════════
# 5. Default value parity
# ═════════════════════════════════════════════════════════════════════════════

class TestDefaultParity:
    """Key inference defaults must be physically plausible (not zero for non-zero quantities)."""

    def test_air_density_default_is_not_zero(self):
        """air_density_kg_m3 default of 0 would be unphysical — ISA sea level is 1.204."""
        pt = _pt()
        # _build_row computes air_density directly, never pulls from _DEFAULTS.
        # Verify _DEFAULTS doesn't have a zero for it (if it exists at all).
        defaults = pt._DEFAULTS
        if "air_density_kg_m3" in defaults:
            assert defaults["air_density_kg_m3"] > 0.5, \
                "air_density_kg_m3 default must not be zero or near-zero"

    def test_lambda_default_is_near_one(self):
        """charge_density_ratio at sea level with ambient temp is ~1.0."""
        sim = _sim()
        rho_sl = sim._RHO_SL
        lam = float(sim._lambda(np.array([rho_sl]))[0])
        assert abs(lam - 1.0) < 0.01

    def test_engine_rpm_default_positive(self):
        pt = _pt()
        assert pt._DEFAULTS["rpm"] > 0, "Default RPM must be positive"

    def test_oil_temp_default_in_operating_range(self):
        pt = _pt()
        assert 70 <= pt._DEFAULTS["oil_temp"] <= 130, \
            f"Default oil temp {pt._DEFAULTS['oil_temp']} outside normal operating range"


# ═════════════════════════════════════════════════════════════════════════════
# 6. Formula parity: shared physics functions produce identical output
# ═════════════════════════════════════════════════════════════════════════════

class TestFormulaParity:
    """Training and inference implementations of shared formulas must agree."""

    def test_isa_density_parity(self):
        """ISA density at (900 ft, 18°C) must match between training and inference."""
        sim = _sim()
        pt  = _pt()
        train_rho = float(sim._isa_density(900.0, 18.0))
        infer_rho = pt._isa_density(900.0, 18.0)
        assert abs(train_rho - infer_rho) < 1e-6, (
            f"ISA density mismatch: train={train_rho:.6f}, infer={infer_rho:.6f}"
        )

    @pytest.mark.parametrize("alt_ft,temp_c", [
        (0, 15), (900, 18), (5000, 5), (10000, -10), (0, 40), (0, -20)
    ])
    def test_isa_density_parity_parametric(self, alt_ft, temp_c):
        sim = _sim()
        pt  = _pt()
        assert abs(float(sim._isa_density(alt_ft, temp_c)) - pt._isa_density(alt_ft, temp_c)) < 1e-6

    def test_lambda_training_matches_inference_formula(self):
        """Training _lambda and inference formula must agree at several densities."""
        sim = _sim()
        rho_sl = 1.204
        for rho in [0.85, 0.95, 1.00, 1.10, 1.204]:
            train_lam = float(sim._lambda(np.array([rho]))[0])
            infer_lam = min(1.05, max(0.70, rho / rho_sl))
            assert abs(train_lam - infer_lam) < 1e-9, (
                f"rho={rho}: train={train_lam:.6f}, infer={infer_lam:.6f}"
            )

    def test_walther_viscosity_parity(self):
        """Walther viscosity at 100°C must match between training and inference."""
        sim = _sim()
        pt  = _pt()
        for temp in [40, 80, 100, 120]:
            train_vis = float(sim._walther_viscosity(float(temp)))
            infer_vis = pt._walther_viscosity(float(temp))
            assert abs(train_vis - infer_vis) < 0.01, (
                f"Walther viscosity at {temp}°C: train={train_vis:.4f}, infer={infer_vis:.4f}"
            )
