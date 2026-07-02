"""
Tests for oil film / lubrication health score physics.

Covers both the scalar inference implementation (pretrained.py) and the
vectorised training implementation (fleet_simulation.py) to guarantee they
produce the same output for identical physical inputs.

Dimensional note
----------------
The function computes a Stribeck/Hersey number proxy:
    H = (η [Pa·s] · N [rps] / P [-])^0.7
where
    ν  [m²/s]  = viscosity_cst × 1e-6              kinematic viscosity
    η  [Pa·s]  = ρ_oil [kg/m³] × ν                 dynamic viscosity
    N  [rps]   = rpm / 60
    P  [-]     = (load_pct/100) × (1 + wear × 0.5) dimensionless load proxy

The result H/(H+0.50) is a normalized lubrication-health score, NOT film thickness.
"""

import sys
import math
import pathlib

import numpy as np
import pytest

# ── import paths ──────────────────────────────────────────────────────────────
REPO_ROOT = pathlib.Path(__file__).parents[2]
sys.path.insert(0, str(REPO_ROOT / "backend"))
sys.path.insert(0, str(REPO_ROOT / "fleet_ai"))

from app.ml.pretrained import _oil_film_ratio as scalar_oil_film_ratio
from app.ml.pretrained import _oil_density
from training.fleet_simulation import _oil_film_ratio as vec_oil_film_ratio
from training.fleet_simulation import _oil_density_arr

# ── helpers ───────────────────────────────────────────────────────────────────

def vec(val):
    """Wrap a scalar as a length-1 numpy array so training impl can consume it."""
    return np.array([val], dtype=float)


def scalar_result(viscosity_cst, oil_temp_c, rpm, load_pct, wear_proxy=0.0):
    return scalar_oil_film_ratio(viscosity_cst, oil_temp_c, rpm, load_pct, wear_proxy)


def vec_result(viscosity_cst, oil_temp_c, rpm, load_pct, wear_proxy=0.0):
    r = vec_oil_film_ratio(
        vec(viscosity_cst), vec(oil_temp_c), vec(rpm), vec(load_pct), vec(wear_proxy)
    )
    return float(r[0])


# ─────────────────────────────────────────────────────────────────────────────
# 1. Oil density model
# ─────────────────────────────────────────────────────────────────────────────

class TestOilDensity:
    def test_reference_temp_15c(self):
        """At 15 °C the SAE 15W-40 reference density is 875 kg/m³."""
        assert _oil_density(15.0) == pytest.approx(875.0, abs=0.1)

    def test_density_decreases_with_temperature(self):
        """Density must fall as temperature rises (liquid expansion)."""
        assert _oil_density(20.0) < _oil_density(15.0)
        assert _oil_density(100.0) < _oil_density(50.0)
        assert _oil_density(140.0) < _oil_density(100.0)

    def test_density_at_100c(self):
        """At 100 °C: 875 − 0.65·85 = 820 kg/m³."""
        expected = 875.0 - 0.65 * (100.0 - 15.0)
        assert _oil_density(100.0) == pytest.approx(expected, abs=0.5)

    def test_lower_clamp_at_extreme_heat(self):
        """Density must not fall below 750 kg/m³ regardless of temperature."""
        assert _oil_density(500.0) == 750.0
        assert _oil_density(300.0) == 750.0

    def test_upper_clamp_at_extreme_cold(self):
        """Density must not exceed 950 kg/m³ regardless of temperature."""
        assert _oil_density(-200.0) == 950.0

    def test_training_density_matches_scalar(self):
        """Training and inference density models must agree."""
        for t in [-10.0, 15.0, 50.0, 80.0, 100.0, 130.0, 200.0]:
            assert float(_oil_density_arr(np.array([t]))[0]) == pytest.approx(
                _oil_density(t), abs=1e-9
            )


# ─────────────────────────────────────────────────────────────────────────────
# 2. Training / inference parity
# ─────────────────────────────────────────────────────────────────────────────

class TestTrainingInferenceParity:
    """Training (numpy) and inference (scalar) must return the same value."""

    CASES = [
        # (viscosity_cst, oil_temp_c, rpm, load_pct, wear_proxy)
        (15.0, 80.0,  1800, 40.0, 0.0),
        (7.0,  120.0, 2500, 70.0, 0.5),
        (80.0, 20.0,  700,  10.0, 0.0),
        (5.0,  140.0, 3000, 95.0, 1.5),
        (12.0, 90.0,  2200, 60.0, 1.0),
    ]

    @pytest.mark.parametrize("case", CASES)
    def test_parity(self, case):
        vsc, t, rpm, lp, wp = case
        s = scalar_result(vsc, t, rpm, lp, wp)
        v = vec_result(vsc, t, rpm, lp, wp)
        assert s == pytest.approx(v, abs=1e-9), (
            f"Training/inference diverge: scalar={s:.6f}, vector={v:.6f} "
            f"for viscosity={vsc} cSt, T={t}°C, rpm={rpm}, load={lp}%, wear={wp}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# 3. Monotonicity: health vs. viscosity
# ─────────────────────────────────────────────────────────────────────────────

class TestMonotonicityViscosity:
    """Higher viscosity → thicker film → better lubrication (within valid range)."""

    def test_increasing_viscosity_improves_health(self):
        base_args = dict(oil_temp_c=90.0, rpm=1800, load_pct=50.0, wear_proxy=0.0)
        results = [scalar_result(v, **base_args) for v in [5.0, 10.0, 15.0, 30.0, 60.0]]
        for lo, hi in zip(results, results[1:]):
            assert lo < hi, f"Expected monotone increase: {results}"

    def test_vec_increasing_viscosity_improves_health(self):
        rpm_arr = vec(1800)
        temp_arr = vec(90.0)
        load_arr = vec(50.0)
        wear_arr = vec(0.0)
        prev = 0.0
        for v in [5.0, 10.0, 15.0, 30.0, 60.0]:
            cur = float(vec_oil_film_ratio(vec(v), temp_arr, rpm_arr, load_arr, wear_arr)[0])
            assert cur > prev, f"Expected monotone increase at viscosity={v}"
            prev = cur


# ─────────────────────────────────────────────────────────────────────────────
# 4. Monotonicity: health vs. surface speed
# ─────────────────────────────────────────────────────────────────────────────

class TestMonotonicitySpeed:
    """Higher rotational speed → more hydrodynamic lift → better film."""

    def test_increasing_rpm_improves_health(self):
        base_args = dict(viscosity_cst=12.0, oil_temp_c=85.0, load_pct=50.0, wear_proxy=0.0)
        results = [scalar_result(rpm=r, **base_args) for r in [500, 1000, 1500, 2000, 3000]]
        for lo, hi in zip(results, results[1:]):
            assert lo < hi, f"Expected monotone increase: {results}"


# ─────────────────────────────────────────────────────────────────────────────
# 5. Monotonicity: health vs. load
# ─────────────────────────────────────────────────────────────────────────────

class TestMonotonicityLoad:
    """Higher bearing load → thinner film → worse lubrication."""

    def test_increasing_load_worsens_health(self):
        base_args = dict(viscosity_cst=15.0, oil_temp_c=80.0, rpm=1800, wear_proxy=0.0)
        results = [scalar_result(load_pct=p, **base_args)
                   for p in [10.0, 30.0, 50.0, 70.0, 90.0]]
        for hi, lo in zip(results, results[1:]):
            assert hi > lo, f"Expected monotone decrease: {results}"

    def test_increasing_wear_worsens_health(self):
        base_args = dict(viscosity_cst=15.0, oil_temp_c=80.0, rpm=1800, load_pct=50.0)
        results = [scalar_result(wear_proxy=w, **base_args) for w in [0.0, 0.5, 1.0, 1.5, 2.0]]
        for hi, lo in zip(results, results[1:]):
            assert hi > lo, f"Expected monotone decrease: {results}"


# ─────────────────────────────────────────────────────────────────────────────
# 6. Output range [0, 1]
# ─────────────────────────────────────────────────────────────────────────────

class TestOutputRange:
    """Result must be in [0, 1] for all plausible and implausible inputs."""

    STRESS_CASES = [
        (0.1,  -40.0, 100,    1.0,  0.0),   # extremely cold, low speed
        (200.0, 0.0,  10000, 100.0, 2.0),   # absurdly thick oil, max load, max wear
        (0.5,  200.0, 5000,   99.0, 2.0),   # very hot thin oil, high load
        (15.0,  80.0,    0,   50.0, 0.0),   # zero RPM
        (15.0,  80.0, 1800,    0.0, 0.0),   # zero load
    ]

    @pytest.mark.parametrize("case", STRESS_CASES)
    def test_scalar_bounded(self, case):
        vsc, t, rpm, lp, wp = case
        r = scalar_result(vsc, t, rpm, lp, wp)
        assert 0.0 <= r <= 1.0, f"Out of bounds: {r} for case {case}"

    @pytest.mark.parametrize("case", STRESS_CASES)
    def test_vec_bounded(self, case):
        vsc, t, rpm, lp, wp = case
        r = vec_result(vsc, t, rpm, lp, wp)
        assert 0.0 <= r <= 1.0, f"Out of bounds: {r} for case {case}"


# ─────────────────────────────────────────────────────────────────────────────
# 7. Zero-RPM boundary condition
# ─────────────────────────────────────────────────────────────────────────────

class TestZeroRPM:
    """Zero RPM = static shaft → boundary / mixed lubrication, not zero-divide."""

    def test_zero_rpm_returns_low_health(self):
        r = scalar_result(15.0, 80.0, 0.0, 30.0, 0.0)
        assert 0.0 <= r < 0.15, f"Expected near-zero health at rpm=0, got {r}"

    def test_zero_rpm_finite(self):
        r = scalar_result(15.0, 80.0, 0.0, 30.0, 0.0)
        assert math.isfinite(r)

    def test_very_low_rpm_near_zero(self):
        low_rpm = scalar_result(15.0, 80.0, 1.0, 30.0, 0.0)
        zero_rpm = scalar_result(15.0, 80.0, 0.0, 30.0, 0.0)
        assert abs(low_rpm - zero_rpm) < 0.05, "Discontinuity near zero RPM"


# ─────────────────────────────────────────────────────────────────────────────
# 8. Cold oil must not produce infinite or perfect film protection
# ─────────────────────────────────────────────────────────────────────────────

class TestColdOil:
    """Very cold, thick oil produces good but finite (<1.0) protection."""

    def test_cold_oil_not_perfect(self):
        r = scalar_result(viscosity_cst=150.0, oil_temp_c=-20.0, rpm=800,
                          load_pct=10.0, wear_proxy=0.0)
        assert r < 1.0, f"Cold oil incorrectly hit ceiling: {r}"
        assert r > 0.85, f"Cold oil unexpectedly low: {r}"

    def test_cold_vs_warm_film(self):
        cold = scalar_result(80.0, 20.0, 800, 10.0, 0.0)
        warm = scalar_result(15.0, 90.0, 800, 10.0, 0.0)
        assert cold > warm, "Cold thick oil should give better film than warm thin oil"


# ─────────────────────────────────────────────────────────────────────────────
# 9. Hot oil must not produce negative viscosity or invalid output
# ─────────────────────────────────────────────────────────────────────────────

class TestHotOil:
    def test_extreme_heat_still_valid(self):
        r = scalar_result(viscosity_cst=3.0, oil_temp_c=160.0, rpm=3000,
                          load_pct=90.0, wear_proxy=1.0)
        assert 0.0 <= r <= 1.0
        assert math.isfinite(r)

    def test_degraded_film_at_high_temp(self):
        good = scalar_result(15.0, 80.0,  1800, 40.0, 0.0)
        bad  = scalar_result(5.0,  140.0, 2500, 80.0, 1.0)
        assert good > bad, "Hot degraded oil should have worse lubrication"


# ─────────────────────────────────────────────────────────────────────────────
# 10. Negative / invalid inputs — sanitization
# ─────────────────────────────────────────────────────────────────────────────

class TestNegativeInputSanitization:
    """Negative physical quantities must be sanitized, not cause crashes or NaN."""

    def test_negative_viscosity(self):
        r = scalar_result(viscosity_cst=-5.0, oil_temp_c=80.0, rpm=1800,
                          load_pct=50.0, wear_proxy=0.0)
        assert 0.0 <= r <= 1.0 and math.isfinite(r)

    def test_negative_rpm(self):
        r = scalar_result(15.0, 80.0, -100, 50.0, 0.0)
        assert 0.0 <= r <= 1.0 and math.isfinite(r)

    def test_negative_load(self):
        r = scalar_result(15.0, 80.0, 1800, -10.0, 0.0)
        assert 0.0 <= r <= 1.0 and math.isfinite(r)

    def test_negative_wear_proxy(self):
        r = scalar_result(15.0, 80.0, 1800, 50.0, -1.0)
        assert 0.0 <= r <= 1.0 and math.isfinite(r)

    def test_negative_inputs_vec(self):
        r = float(vec_oil_film_ratio(vec(-5.0), vec(80.0), vec(-100.0),
                                     vec(-10.0), vec(-1.0))[0])
        assert 0.0 <= r <= 1.0 and math.isfinite(r)


# ─────────────────────────────────────────────────────────────────────────────
# 11. Calibration check — known reference point
# ─────────────────────────────────────────────────────────────────────────────

class TestCalibration:
    """
    Reference point documented in the function docstring:
        15 cSt / 80 °C / 1800 rpm / 40% load / 0 wear → ≈ 0.656

    Hand-computed:
        ν   = 15e-6 m²/s
        ρ   = 875 − 0.65·65 = 832.75 kg/m³
        η   = 0.012491 Pa·s
        N   = 30 rps
        P   = 0.40
        H   = (0.012491·30/0.40)^0.7 = (0.93683)^0.7 ≈ 0.9554
        score = 0.9554/(0.9554+0.50) ≈ 0.656
    """
    def test_reference_point_scalar(self):
        r = scalar_result(15.0, 80.0, 1800, 40.0, 0.0)
        assert r == pytest.approx(0.656, abs=0.005), f"Got {r}"

    def test_reference_point_vec(self):
        r = vec_result(15.0, 80.0, 1800, 40.0, 0.0)
        assert r == pytest.approx(0.656, abs=0.005), f"Got {r}"


# ─────────────────────────────────────────────────────────────────────────────
# 12. Before/after regression — values must differ from the old broken impl
# ─────────────────────────────────────────────────────────────────────────────

class TestBeforeAfterRegression:
    """
    The old inference implementation clipped to 1.0 for nearly all normal
    conditions because the nominal was computed in rps but training used
    raw RPM — a 60× divergence.  These tests confirm the corrected values.

    Before (old inference):
        Case 1 (15 cSt, 80°C, 1800 rpm, 40% load): 1.0  (clipped)
        Case 2 (7 cSt, 120°C, 2500 rpm, 70% load, 0.5 wear): 1.0  (clipped)
        Case 3 (80 cSt, 20°C, 700 rpm, 10% load): 1.0  (clipped)

    After (corrected):
        Case 1: ≈ 0.656
        Case 2: ≈ 0.444
        Case 3: ≈ 0.897
    """
    def test_case1_no_longer_clipped(self):
        r = scalar_result(15.0, 80.0, 1800, 40.0, 0.0)
        assert r < 0.99, f"Value still clipping: {r} — fix not applied"

    def test_case2_no_longer_clipped(self):
        r = scalar_result(7.0, 120.0, 2500, 70.0, 0.5)
        assert r < 0.99, f"Value still clipping: {r} — fix not applied"

    def test_case3_no_longer_clipped(self):
        r = scalar_result(80.0, 20.0, 700, 10.0, 0.0)
        assert r < 0.99, f"Value still clipping: {r} — fix not applied"

    def test_case1_approximate_value(self):
        r = scalar_result(15.0, 80.0, 1800, 40.0, 0.0)
        assert r == pytest.approx(0.656, abs=0.01)

    def test_case2_approximate_value(self):
        r = scalar_result(7.0, 120.0, 2500, 70.0, 0.5)
        assert r == pytest.approx(0.444, abs=0.015)

    def test_case3_approximate_value(self):
        r = scalar_result(80.0, 20.0, 700, 10.0, 0.0)
        assert r == pytest.approx(0.897, abs=0.01)


# ─────────────────────────────────────────────────────────────────────────────
# 13. Dimensional analysis assertions (documented units)
# ─────────────────────────────────────────────────────────────────────────────

class TestDimensionalAnalysis:
    """
    Verify units by checking that scaling inputs by their physical
    conversion factors produces the expected transformed output.
    """

    def test_rpm_to_rps_scaling(self):
        """
        Internally N = rpm/60.  Doubling rpm must double N, increasing H
        and therefore increasing the lubrication-health score.
        """
        r1 = scalar_result(15.0, 80.0, 1000, 50.0, 0.0)
        r2 = scalar_result(15.0, 80.0, 2000, 50.0, 0.0)
        assert r2 > r1, "Doubling rpm must improve film health"

    def test_cst_to_m2_per_s_factor(self):
        """
        1 cSt = 1e-6 m²/s.  A 10× increase in viscosity_cst must produce
        a strictly larger Stribeck proxy and thus a higher health score.
        """
        r1 = scalar_result(10.0, 80.0, 1800, 50.0, 0.0)
        r2 = scalar_result(100.0, 80.0, 1800, 50.0, 0.0)
        assert r2 > r1, "10× viscosity increase must improve film health"

    def test_dynamic_vs_kinematic_distinction(self):
        """
        ρ·ν [Pa·s] ≠ ν [m²/s].  The health score at cold temperature (high ρ)
        must be higher than at hot temperature (low ρ) for the same kinematic
        viscosity — confirming the density multiplier is active.
        """
        same_cst = 15.0
        r_cold = scalar_result(same_cst, 20.0,  1800, 50.0, 0.0)
        r_hot  = scalar_result(same_cst, 130.0, 1800, 50.0, 0.0)
        assert r_cold > r_hot, (
            "At the same kinematic viscosity, denser cold oil must have "
            "higher dynamic viscosity and thus better film score."
        )
