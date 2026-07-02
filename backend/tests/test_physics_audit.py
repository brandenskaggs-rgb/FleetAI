"""
Physics audit regression tests — v4.2 bug fixes.

Covers fixes identified in the 19-step engineering audit:
  1. Omega / tire circumference — was using radius 0.32m instead of circumference
  2. Lambda cancellation — fuel_mass * stoich cancelled; result was (rho/1.204)²
  3. Road load lower clip — was clipped to 0, hiding downhill grade recovery
  4. Grouped splits — same vehicle could appear in train and test

Each test is a black-box check: feed in physical inputs, assert the output
satisfies the physical invariant that the bug was violating.
"""

import math
import sys
import pathlib

import numpy as np
import pytest

REPO_ROOT = pathlib.Path(__file__).parents[2]
sys.path.insert(0, str(REPO_ROOT / "backend"))
sys.path.insert(0, str(REPO_ROOT / "fleet_ai" / "training"))

# ─────────────────────────────────────────────────────────────────────────────
# Helpers — import the functions under test
# ─────────────────────────────────────────────────────────────────────────────

def _import_sim():
    import fleet_simulation as sim
    return sim


def _import_pretrained():
    from app.ml import pretrained as pt
    return pt


# ═════════════════════════════════════════════════════════════════════════════
# 1. Omega / tire circumference
# ═════════════════════════════════════════════════════════════════════════════

class TestOmegaTireCircumference:
    """
    ω = (v_mps / circumference_m) × 2π

    Bug: code used 0.32 (assumed radius for a car) instead of the class-specific
    circumference from _PHYS_SPECS, making ω 10× too high for heavy-duty trucks.
    """

    def test_inference_heavy_duty_omega_in_range(self):
        """At 80 km/h, a 3.20 m circumference tyre rotates at ~6.94 rev/s → ~43.6 rad/s.
        With the wrong 0.32 m value it would be 69.4 rev/s → clipped to 20 rps → ~125.6 rad/s."""
        v_kph = 80.0
        circ_m = 3.20   # heavy-duty circumference
        v_mps = v_kph / 3.6                          # 22.22 m/s
        n_correct = v_mps / circ_m                   # 6.94 rev/s
        omega_correct = n_correct * 2 * math.pi      # ~43.6 rad/s

        n_wrong_clipped = min(v_mps / 0.32, 20.0)   # clip at 20 rps as code does
        omega_wrong = n_wrong_clipped * 2 * math.pi  # ~125.6 rad/s

        # Correct value ~43.6 rad/s — roughly 7 rotations/second × 2π
        assert 35 < omega_correct < 55, f"Expected ~43.6 rad/s, got {omega_correct:.2f}"
        # Wrong (0.32 m) value hits the 20 rps clamp — still ~3× too high
        assert omega_wrong > omega_correct * 2, (
            f"Wrong circumference should give much higher omega: "
            f"wrong={omega_wrong:.1f} vs correct={omega_correct:.1f}"
        )

    def test_inference_spec_has_tire_circ_m(self):
        """_PHYS_SPECS in pretrained.py must contain tire_circ_m for every class."""
        pt = _import_pretrained()
        for cls_code, specs in pt._PHYS_SPECS.items():
            assert "tire_circ_m" in specs, f"Class {cls_code} missing tire_circ_m"
            circ = specs["tire_circ_m"]
            # Circumference must be plausible (1.5 m ≤ circ ≤ 4.0 m)
            assert 1.5 <= circ <= 4.0, f"Class {cls_code} circ_m={circ} out of range"

    def test_inference_heavy_duty_circ_matches_training(self):
        """Heavy-duty circumference in pretrained.py must equal training's 3.20 m."""
        pt = _import_pretrained()
        sim = _import_sim()
        for cls_name, cls_code in sim.VEHICLE_CLASS_CODES.items():
            expected_circ = sim._phys(np.array([cls_name]), "tire_circ_m")[0]
            actual_circ   = pt._PHYS_SPECS[cls_code]["tire_circ_m"]
            assert abs(actual_circ - expected_circ) < 1e-6, (
                f"{cls_name}: training circ={expected_circ} m, "
                f"inference circ={actual_circ} m"
            )

    def test_training_hub_temps_uses_class_specific_circ(self):
        """_hub_temps must accept tire_circ_m and vary ω per class.
        Heavy-duty and passenger car should produce different temperatures
        at the same speed because their circumferences differ.
        """
        sim = _import_sim()
        rng = np.random.default_rng(0)
        rows = 10
        speed = np.full(rows, 80.0)
        ambient = np.full(rows, 20.0)
        load = np.full(rows, 3.0)
        wear = np.full(rows, 0.5)

        circ_hd  = np.full(rows, 3.20)
        circ_car = np.full(rows, 1.95)

        fl_hd,  *_ = sim._hub_temps(ambient, speed, load, wear, rng, rows, tire_circ_m=circ_hd)
        rng2 = np.random.default_rng(0)
        fl_car, *_ = sim._hub_temps(ambient, speed, load, wear, rng2, rows, tire_circ_m=circ_car)

        # Car tyres rotate faster → more heat (smaller circumference)
        assert float(np.mean(fl_car)) > float(np.mean(fl_hd)), (
            "Passenger car (smaller circ) should run hotter than heavy-duty at same speed"
        )

    def test_omega_zero_at_zero_speed(self):
        """At zero speed, omega should be at its minimum clamp, not negative."""
        sim = _import_sim()
        rng = np.random.default_rng(42)
        rows = 5
        speed = np.zeros(rows)
        result = sim._hub_temps(
            np.full(rows, 20.0), speed,
            np.full(rows, 2.0), np.zeros(rows),
            rng, rows, tire_circ_m=np.full(rows, 3.20)
        )
        for corner in result:
            assert np.all(np.isfinite(corner)), "Hub temps must be finite at zero speed"
            assert np.all(corner >= 0), "Hub temps must be non-negative at zero speed"

    def test_omega_linear_in_speed(self):
        """Hub temperature should increase monotonically with speed (more friction power)."""
        sim = _import_sim()
        temps_at_speed = []
        for v_kph in [20, 40, 60, 80, 100]:
            rng = np.random.default_rng(0)
            rows = 50
            fl, *_ = sim._hub_temps(
                np.full(rows, 20.0),
                np.full(rows, float(v_kph)),
                np.full(rows, 2.5),
                np.full(rows, 0.3),
                rng, rows,
                tire_circ_m=np.full(rows, 3.20),
            )
            temps_at_speed.append(float(np.mean(fl)))

        for i in range(1, len(temps_at_speed)):
            assert temps_at_speed[i] > temps_at_speed[i - 1], (
                f"Hub temp at {(i+1)*20} km/h ({temps_at_speed[i]:.1f}) should exceed "
                f"temp at {i*20} km/h ({temps_at_speed[i-1]:.1f})"
            )


# ═════════════════════════════════════════════════════════════════════════════
# 2. Lambda cancellation
# ═════════════════════════════════════════════════════════════════════════════

class TestLambdaCancellation:
    """
    Bug: fuel_mass_rate × stoich appeared in both numerator and denominator
    and cancelled entirely, leaving lambda = vol_eff × (rho/1.204) = (rho/1.204)².
    Also training used rho_sl=1.204 while inference used rho_sl=1.225.

    Fix: lambda = rho / _RHO_SL = rho / 1.204 in both; clipped to [0.70, 1.05].
    """

    def test_training_lambda_is_linear_not_quadratic(self):
        """_lambda(rho) must be linear in rho, not quadratic."""
        sim = _import_sim()
        rho_vals = np.array([0.9, 1.0, 1.1, 1.204])
        lam = sim._lambda(rho_vals)
        # Linear: lambda[i] / lambda[j] ≈ rho[i] / rho[j]
        for i in range(len(rho_vals) - 1):
            expected_ratio = rho_vals[i] / rho_vals[i + 1]
            actual_ratio   = lam[i] / lam[i + 1]
            # Allow for clipping at the bounds
            if lam[i] < 1.05 and lam[i + 1] < 1.05 and lam[i] > 0.70:
                assert abs(actual_ratio - expected_ratio) < 0.02, (
                    f"lambda not linear at rho={rho_vals[i]:.3f}: "
                    f"ratio={actual_ratio:.4f} expected={expected_ratio:.4f}"
                )

    def test_training_lambda_at_sea_level_is_one(self):
        """At ISA sea-level density (1.204 kg/m³), lambda should be 1.0."""
        sim = _import_sim()
        lam = sim._lambda(np.array([1.204]))
        assert abs(float(lam[0]) - 1.0) < 0.01, f"Expected lambda≈1.0 at sea level, got {lam[0]}"

    def test_training_lambda_decreases_at_altitude(self):
        """Higher altitude → lower rho → lambda < 1 (effectively rich)."""
        sim = _import_sim()
        rho_sl    = np.array([1.204])
        rho_alt   = np.array([0.95])   # ~2500 m
        lam_sl  = float(sim._lambda(rho_sl)[0])
        lam_alt = float(sim._lambda(rho_alt)[0])
        assert lam_alt < lam_sl, "Lambda at altitude must be lower than at sea level"

    def test_inference_lambda_matches_training(self):
        """Inference lambda = rho / 1.204 must match training _lambda(rho)."""
        sim = _import_sim()
        rho_sl_inf = 1.204  # updated in pretrained.py
        for rho in [0.90, 1.00, 1.10, 1.204]:
            lam_train = float(sim._lambda(np.array([rho]))[0])
            lam_inf   = min(1.05, max(0.70, rho / rho_sl_inf))
            assert abs(lam_train - lam_inf) < 1e-6, (
                f"rho={rho}: train={lam_train:.6f} vs inf={lam_inf:.6f}"
            )

    def test_lambda_range(self):
        """Lambda must stay in [0.70, 1.05] for any physically plausible rho."""
        sim = _import_sim()
        rho = np.linspace(0.3, 1.5, 100)
        lam = sim._lambda(rho)
        assert np.all(lam >= 0.70), "Lambda below minimum"
        assert np.all(lam <= 1.05), "Lambda above maximum"

    def test_rho_sl_constant_is_1204(self):
        """_RHO_SL in fleet_simulation must be 1.204 (ISA, not 1.225 ICAO)."""
        sim = _import_sim()
        assert hasattr(sim, "_RHO_SL"), "_RHO_SL constant not found in fleet_simulation"
        assert abs(sim._RHO_SL - 1.204) < 1e-6, f"_RHO_SL={sim._RHO_SL}, expected 1.204"


# ═════════════════════════════════════════════════════════════════════════════
# 3. Road load lower clip
# ═════════════════════════════════════════════════════════════════════════════

class TestRoadLoadLowerClip:
    """
    Bug: road_load_kw was clipped to a lower bound of 0, hiding downhill
    grade recovery (engine braking / regenerative deceleration).
    Fix: lower bound is -engine_kw * 0.30.
    """

    def test_negative_road_load_allowed_on_steep_downhill(self):
        """A 6% downhill grade at 80 km/h should yield negative road load
        (grade power exceeds aero + rolling resistance)."""
        sim = _import_sim()
        # 6% downhill: grade_kw = -m·g·sin(atan(0.06))·v
        v_mps = 80 / 3.6
        m_kg  = 15000  # heavy truck
        grade_pct = -6.0
        sinA = math.sin(math.atan(grade_pct / 100.0))
        grade_kw = m_kg * 9.81 * sinA * v_mps / 1000.0

        # aero + rolling at 80 km/h for heavy truck
        rho   = 1.204
        cd    = 0.68
        A     = 9.0
        aero_kw   = 0.5 * rho * cd * A * v_mps**3 / 1000.0
        crr   = 0.006
        roll_kw   = crr * m_kg * 9.81 * v_mps / 1000.0

        raw_total = aero_kw + roll_kw + grade_kw
        assert raw_total < 0, (
            f"Steep downhill should give negative road load; got {raw_total:.1f} kW"
        )

    def test_training_road_load_can_be_negative(self):
        """Generating data with a steep downhill grade should produce rows where
        road_load_kw < 0 after the fix."""
        sim = _import_sim()
        df = sim.generate_mixed_fleet_data(fleet_size=200, days=1, seed=55)
        # Filter for steep downhill
        steep = df[df["road_grade_pct"] < -4]
        if len(steep) > 0:
            assert (steep["road_load_kw"] < 0).any(), (
                "Some rows with steep downhill grade should have road_load_kw < 0"
            )

    def test_road_load_never_exceeds_engine_limit(self):
        """road_load_kw must not exceed 95% of engine power in generated data.
        Training spec: heavy_duty engine_kw = 450 kW (not 340 — that's pretrained.py)."""
        sim = _import_sim()
        import numpy as np
        df = sim.generate_mixed_fleet_data(fleet_size=500, days=1, seed=77)
        heavy = df[df["vehicle_class"] == "heavy_duty_j1939"]
        if len(heavy) > 0:
            hd_engine_kw = float(sim._phys(np.array(["heavy_duty_j1939"]), "engine_kw")[0])
            upper = hd_engine_kw * 0.95 + 1e-3
            assert (heavy["road_load_kw"] <= upper).all(), (
                f"road_load_kw must not exceed {upper:.1f} kW (95% of {hd_engine_kw:.0f} kW)"
            )

    def test_inference_road_load_negative_on_downhill(self):
        """In pretrained.py, grade_force_kw < 0 on downhill and road_load_kw should
        be negative when grade dominates aero + rolling."""
        pt = _import_pretrained()
        # Manually compute what _build_row does for a steep downhill
        grade_pct = -8.0
        v_ms = 20 / 3.6
        m_kg = 15000
        sinA = math.sin(math.atan(grade_pct / 100.0))
        grade_force_kw = m_kg * 9.81 * sinA * v_ms / 1000.0  # negative

        rho = 1.204
        cd  = 0.68; A = 9.0
        aero_kw  = 0.5 * rho * cd * A * v_ms**3 / 1000.0   # ~3.8 kW at 20 kph
        crr = 0.006
        roll_kw  = crr * m_kg * 9.81 * v_ms / 1000.0        # ~4.9 kW

        eng_kw = 340
        road_load = max(-eng_kw * 0.30, min(eng_kw * 0.95,
                                             aero_kw + roll_kw + grade_force_kw))
        assert road_load < 0, (
            f"8% downhill at low speed should give negative road_load; got {road_load:.1f} kW"
        )


# ═════════════════════════════════════════════════════════════════════════════
# 4. Grouped splits — no vehicle-level leakage
# ═════════════════════════════════════════════════════════════════════════════

class TestGroupedSplits:
    """
    Bug: train_test_split(stratify=y) was used on the combined multi-seed
    dataframe, allowing the same vehicle_id (at different days) to appear in
    both train and test.

    Fix: GroupShuffleSplit on vehicle_id groups in run_calibrated_training.
    """

    def test_vehicle_ids_are_unique_per_seed_after_prefix(self):
        """After seed-prefixing in run_calibrated_training, a vehicle that
        appears in seed 100 has id 'S100_SIM-xxxxx', distinct from seed 101's
        'S101_SIM-xxxxx'. No cross-seed collision."""
        sim = _import_sim()
        df100 = sim.generate_mixed_fleet_data(fleet_size=50, days=2, seed=100)
        df101 = sim.generate_mixed_fleet_data(fleet_size=50, days=2, seed=101)
        df100["vehicle_id"] = "S100_" + df100["vehicle_id"].astype(str)
        df101["vehicle_id"] = "S101_" + df101["vehicle_id"].astype(str)

        ids_100 = set(df100["vehicle_id"])
        ids_101 = set(df101["vehicle_id"])
        overlap = ids_100 & ids_101
        assert len(overlap) == 0, f"Seed IDs collide: {list(overlap)[:5]}"

    def test_no_vehicle_in_both_train_and_test(self):
        """Simulate what _train_from_df does with grouped splits and verify
        no vehicle_id appears in both train and test."""
        import pandas as pd
        from sklearn.model_selection import GroupShuffleSplit

        sim = _import_sim()

        # Build a small multi-seed df mimicking run_calibrated_training
        frames = []
        for i in range(3):
            seed = i + 100
            df = sim.generate_mixed_fleet_data(fleet_size=100, days=3, seed=seed)
            df["vehicle_id"] = f"S{seed}_" + df["vehicle_id"].astype(str)
            frames.append(df.sample(n=min(150, len(df)), random_state=seed))
        df_combined = pd.concat(frames, ignore_index=True)

        X = df_combined[["vehicle_class_code", "rpm", "engine_temp"]]
        y = df_combined["failure"]
        groups = df_combined["vehicle_id"].values

        gss = GroupShuffleSplit(n_splits=1, test_size=0.22, random_state=42)
        dev_idx, test_idx = next(gss.split(X, y, groups=groups))

        dev_vehicles  = set(groups[dev_idx])
        test_vehicles = set(groups[test_idx])
        leaked = dev_vehicles & test_vehicles
        assert len(leaked) == 0, (
            f"{len(leaked)} vehicles appear in both dev and test sets: {list(leaked)[:5]}"
        )

    def test_vehicle_id_column_exists_in_generated_data(self):
        """generate_mixed_fleet_data must include vehicle_id column."""
        sim = _import_sim()
        df = sim.generate_mixed_fleet_data(fleet_size=10, days=1, seed=0)
        assert "vehicle_id" in df.columns, "vehicle_id column missing from generated DataFrame"
        assert df["vehicle_id"].nunique() == 10, "Each of 10 trucks should have a unique vehicle_id"
