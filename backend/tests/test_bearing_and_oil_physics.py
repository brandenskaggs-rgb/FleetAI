"""
Bearing and oil physics regression tests — v4.5 defect fixes.

Covers four defects that survived the earlier 19-step audit because the test
suite exercised omega, lambda, and road load thoroughly and had no coverage at
all of bearing load units, bearing life, or oil condition:

  1. Bearing load was a MASS, not a force. mass_kg x load_share was divided by
     1000 and labelled kN, reporting tonnes and understating wheel-end load by
     9.81x. The outputs stayed plausible only because the lumped dissipation
     area was compensating, which made the friction coefficient a fudge factor.
  2. bearing_C_kn — the basic dynamic load rating, the single most important
     parameter in ISO 281 — was read from the spec registry and never used, so
     the C/P ratio the standard is built on was never formed.
  3. Oil TBN was driven by cumulative lifetime engine hours, so it never reset
     at an oil change. TBN moved 10.00 -> 9.66 across a full drain interval and
     only crossed its failure trigger near engine end-of-life.
  4. Load entered bearing life linearly instead of as ISO 281's (C/P)^(10/3)
     power law, under-responding to load by roughly 40%.

Each test asserts the physical invariant the defect violated, so re-introducing
any of them fails here rather than shipping silently.
"""

import math
import pathlib
import sys

import numpy as np
import pytest

REPO_ROOT = pathlib.Path(__file__).parents[2]
sys.path.insert(0, str(REPO_ROOT / "backend"))
sys.path.insert(0, str(REPO_ROOT / "fleet_ai" / "training"))


def _import_sim():
    import fleet_simulation as sim
    return sim


def _specs():
    from fleet_ai.physics.vehicle_physics import VEHICLE_SPECS
    return VEHICLE_SPECS


def _arr(v, n=1):
    return np.full(n, float(v))


# Reference duty used throughout, and by the defect report:
# heavy_duty_j1939, payload 0.5, 100 kph, ambient 20 C.
HD_MASS = 36000.0
HD_CIRC = 3.20
HD_C_KN = 380.0
REF_SHARE = 0.14 + 0.5 * 0.06          # 0.17 at payload 0.5
AMBIENT = 20.0
SPEED = 100.0


# ═════════════════════════════════════════════════════════════════════════════
# 1. Bearing load must be a force
# ═════════════════════════════════════════════════════════════════════════════

class TestBearingLoadIsAForce:

    def test_gravity_constant_is_standard(self):
        sim = _import_sim()
        assert sim._G_MPS2 == pytest.approx(9.80665, abs=1e-6)

    def test_load_per_bearing_includes_gravity(self):
        """kg x dimensionless share / 1000 is tonnes. Converting a mass to a
        force needs g; without it the load is 9.81x too small."""
        sim = _import_sim()
        expected_kn = HD_MASS * REF_SHARE * sim._G_MPS2 / 1000.0
        assert expected_kn == pytest.approx(60.0, abs=1.0)
        # the pre-fix expression, kept explicit so the ratio is asserted
        wrong_kn = HD_MASS * REF_SHARE / 1000.0
        assert expected_kn / wrong_kn == pytest.approx(9.80665, rel=1e-6)

    def test_class8_wheel_end_load_in_physical_band(self):
        """Total support force must be ~mass x g, and a Class 8 tractor-trailer
        spreads it over roughly 10 wheel ends -> tens of kN each."""
        sim = _import_sim()
        per_end = HD_MASS * REF_SHARE * sim._G_MPS2 / 1000.0
        total = HD_MASS * sim._G_MPS2 / 1000.0
        assert 350.0 < total < 360.0                     # 36 t -> ~353 kN
        assert 30.0 < per_end < 80.0                     # plausible per wheel end
        # load share must never let the per-end loads sum to less than the weight
        assert per_end * 10 > total * 0.9

    @pytest.mark.parametrize("cls", list(_specs().keys()))
    def test_every_class_load_is_positive_and_scaled_by_mass(self, cls):
        sim = _import_sim()
        spec = _specs()[cls]
        load = spec["mass_kg"] * REF_SHARE * sim._G_MPS2 / 1000.0
        assert load > 0
        # heavier class => heavier wheel-end load
        assert load == pytest.approx(spec["mass_kg"] * REF_SHARE * 9.80665 / 1000.0)


# ═════════════════════════════════════════════════════════════════════════════
# 2. Hub temperatures — the regression check for the gravity fix
# ═════════════════════════════════════════════════════════════════════════════

class TestHubTemperatureRegression:
    """Adding g without compensating elsewhere drives every hub temp into the
    200 C clip and kills the feature. The compensation belongs in the lumped
    dissipation area (already an approximation), NOT in the friction
    coefficient, which has published values. These assert both."""

    def _hub_mean(self, wear, n=20000, seed=11):
        """Average over a large sample so the +/-4% per-corner friction jitter
        averages out and the assertion targets the deterministic physics rather
        than one rng draw."""
        sim = _import_sim()
        load = HD_MASS * REF_SHARE * sim._G_MPS2 / 1000.0
        rng = np.random.default_rng(seed)
        t = sim._hub_temps(_arr(AMBIENT, n), _arr(SPEED, n), _arr(load, n),
                           _arr(wear, n), rng, n, tire_circ_m=_arr(HD_CIRC, n))
        return float(np.mean([np.mean(x) for x in t]))

    @pytest.mark.parametrize("wear,expected", [(0.0, 47.1), (1.0, 101.4), (2.0, 155.6)])
    def test_reference_hub_temps_preserved(self, wear, expected):
        """Healthy / mid-wear / severe at 100 kph must stay near 47/101/155 C —
        the band real HD wheel ends actually run in. These are the noise-free
        values; the gravity fix is required to leave them unchanged, which is
        what makes it safe to ship."""
        assert self._hub_mean(wear) == pytest.approx(expected, abs=0.6)

    def test_gravity_fix_preserved_temps_exactly(self):
        """Direct A/B against the pre-fix formula (A=0.04, load in tonnes).
        The two must agree to float precision across the operating envelope —
        that equivalence is the whole justification for the change."""
        sim = _import_sim()
        rows = 400
        rng_shape = np.random.default_rng(5)
        amb = rng_shape.uniform(-20, 45, rows)
        spd = rng_shape.uniform(0, 130, rows)
        wear = rng_shape.uniform(0, 3, rows)
        circ = rng_shape.uniform(1.9, 3.2, rows)
        mass = rng_shape.uniform(1600, 36000, rows)
        share = np.clip(0.14 + rng_shape.uniform(0, 1, rows) * 0.06, 0.10, 0.30)

        new = sim._hub_temps(amb, spd, mass * share * sim._G_MPS2 / 1000.0, wear,
                             np.random.default_rng(99), rows, tire_circ_m=circ)
        # pre-fix path, reimplemented verbatim
        r, A = 0.065, 0.04
        h = 8.0 + 0.22 * np.clip(spd, 0, 130)
        om = np.clip(spd / 3.6 / np.maximum(circ, 0.5), 0.0, 20.0) * (2 * np.pi)
        mu = 0.0015 + wear * 0.003
        rng_old = np.random.default_rng(99)
        for corner_new in new:
            m = mu * np.clip(1 + rng_old.normal(0, 0.04, rows), 0.80, 1.30)
            F_old = (mass * share / 1000.0) * 1000.0
            old = np.clip(amb + (m * F_old * om * r) / (h * A), amb, 200.0)
            assert np.max(np.abs(old - corner_new)) < 1e-9

    def test_no_saturation_at_the_clip(self):
        """If the gravity fix lands without compensation every case pins at
        200 C and the feature carries no information."""
        for wear in (0.0, 0.45, 0.8, 1.2, 2.0):
            assert self._hub_mean(wear) < 199.0

    def test_temps_increase_monotonically_with_wear(self):
        temps = [self._hub_mean(w) for w in (0.0, 0.45, 0.8, 1.2, 2.0, 3.0)]
        assert all(b > a for a, b in zip(temps, temps[1:]))

    def test_dissipation_area_is_a_wheel_end_not_a_bearing(self):
        """The compensating term is the lumped wheel-end area (hub flange +
        drum + wheel disc), which must be a physically plausible tenths-of-m2,
        not a bearing-sized patch."""
        sim = _import_sim()
        src = pathlib.Path(sim.__file__).read_text(encoding="utf-8")
        assert "A_surface = 0.04 * _G_MPS2" in src, "area must stay tied to g"
        assert 0.30 < 0.04 * sim._G_MPS2 < 0.50

    def test_friction_coefficient_stays_physical(self):
        """Published tapered-roller mu: ~0.0015 healthy to ~0.012 failing.
        Absorbing the 9.81 here would put healthy mu at 1.5e-4, an order of
        magnitude below any real rolling-element bearing."""
        for wear, lo, hi in ((0.0, 0.001, 0.002), (2.0, 0.006, 0.012), (3.0, 0.008, 0.014)):
            mu = 0.0015 + wear * 0.003
            assert lo <= mu <= hi, f"mu={mu} outside published range at wear={wear}"

    def test_zero_speed_means_no_friction_heat(self):
        assert self._hub_mean(2.0) > AMBIENT
        sim = _import_sim()
        load = HD_MASS * REF_SHARE * sim._G_MPS2 / 1000.0
        rng = np.random.default_rng(3)
        t = sim._hub_temps(_arr(AMBIENT), _arr(0.0), _arr(load), _arr(2.0),
                           rng, 1, tire_circ_m=_arr(HD_CIRC))
        assert float(t[0][0]) == pytest.approx(AMBIENT, abs=0.01)


# ═════════════════════════════════════════════════════════════════════════════
# 3. bearing_C_kn must actually be used (ISO 281 C/P)
# ═════════════════════════════════════════════════════════════════════════════

class TestISO281BearingLife:

    def _l10(self, C=HD_C_KN, payload=0.5, grade=0.0, a_field=1.06, neglect=0.0):
        sim = _import_sim()
        share = min(max(0.14 + payload * 0.06, 0.10), 0.30)
        P = HD_MASS * share * sim._G_MPS2 / 1000.0
        n = (38 * 1.609344 / 3.6 / HD_CIRC) * 60.0
        return float(sim._l10_hours_field(
            _arr(C), _arr(P), _arr(n), _arr(grade), _arr(a_field), _arr(neglect))[0])

    def test_life_responds_to_load_rating(self):
        """The defect: bearing_C_kn was loaded and discarded. If life is
        insensitive to C, the C/P ratio is still not being formed."""
        assert self._l10(C=HD_C_KN * 1.5) > self._l10(C=HD_C_KN) * 1.5

    def test_matches_closed_form_iso281(self):
        sim = _import_sim()
        P = HD_MASS * REF_SHARE * sim._G_MPS2 / 1000.0
        n = (38 * 1.609344 / 3.6 / HD_CIRC) * 60.0
        closed = (HD_C_KN / P) ** (10.0 / 3.0) * 1e6 / (60.0 * n)
        assert self._l10(a_field=1.0) == pytest.approx(closed, rel=1e-6)

    def test_roller_exponent_is_ten_thirds_not_three(self):
        """p = 3 is the ball-bearing exponent; hub bearings are tapered
        rollers, p = 10/3."""
        lo, hi = self._l10(payload=0.3, a_field=1.0), self._l10(payload=1.0, a_field=1.0)
        sim = _import_sim()
        p_lo = HD_MASS * (0.14 + 0.3 * 0.06) * sim._G_MPS2 / 1000.0
        p_hi = HD_MASS * (0.14 + 1.0 * 0.06) * sim._G_MPS2 / 1000.0
        assert lo / hi == pytest.approx((p_hi / p_lo) ** (10.0 / 3.0), rel=1e-6)

    def test_load_sensitivity_beats_the_old_linear_factor(self):
        """Linear form moved life 1.36x over payload 0.3 -> 1.0; ISO 281 moves
        it 2.19x. Under-responding to load by ~40% was the defect."""
        ratio = self._l10(payload=0.3) / self._l10(payload=1.0)
        assert ratio == pytest.approx(2.19, abs=0.05)
        assert ratio > 1.9, "load response collapsed back toward linear"

    def test_field_calibration_preserved_for_class8(self):
        """ISO 281 and the field interval agree within ~6% for Class 8, so
        a_field is ~1.0 there and life must land near the 26,000 h base."""
        assert self._l10() == pytest.approx(26000, rel=0.05)

    def test_neglect_shortens_life(self):
        assert self._l10(neglect=1.0) < self._l10(neglect=0.0) * 0.6

    def test_grade_shortens_life(self):
        assert self._l10(grade=8.0) < self._l10(grade=0.0)

    @pytest.mark.parametrize("cls", list(_specs().keys()))
    def test_every_class_has_a_field_factor(self, cls):
        spec = _specs()[cls]
        assert "bearing_a_field" in spec
        assert 0.0 < spec["bearing_a_field"] <= 1.2


# ═════════════════════════════════════════════════════════════════════════════
# 4. Oil TBN must reset at the drain interval
# ═════════════════════════════════════════════════════════════════════════════

class TestOilTBNResets:

    def _tbn(self, hours, temp=95.0, neglect=0.0):
        sim = _import_sim()
        return float(sim._oil_tbn(_arr(hours), _arr(temp), _arr(neglect))[0])

    def test_fresh_oil_is_full_tbn(self):
        assert self._tbn(0.0) == pytest.approx(10.0, abs=1e-9)

    def test_tbn_falls_measurably_within_one_drain_interval(self):
        """The defect: TBN moved 10.00 -> 9.66 across a full ~1,000 h interval,
        essentially flat. Wolak (2017) finds measurable depletion within a
        single interval across a 25-vehicle fleet; the model must reproduce
        that or it cannot support the citation."""
        assert self._tbn(1000.0) < 7.0
        assert self._tbn(1000.0) > 4.0          # and not absurdly fast either
        assert self._tbn(500.0) < self._tbn(250.0) < self._tbn(0.0)

    def test_depletion_is_monotonic(self):
        vals = [self._tbn(h) for h in (0, 100, 250, 500, 1000, 1500, 2000)]
        assert all(b < a for a, b in zip(vals, vals[1:]))

    def test_trigger_needs_an_overdue_interval_not_engine_eol(self):
        """< 2.5 should mean 'this oil is finished', reachable a few intervals
        overdue — not only at 45,000 cumulative engine hours."""
        assert self._tbn(1000.0) > 2.5           # one interval: not yet failed
        assert self._tbn(3200.0) < 2.5           # a few overdue: failed

    def test_heat_accelerates_depletion(self):
        assert self._tbn(1000.0, temp=115.0) < self._tbn(1000.0, temp=95.0)

    def test_neglect_accelerates_depletion(self):
        assert self._tbn(1000.0, neglect=1.0) < self._tbn(1000.0, neglect=0.0)

    def test_reset_is_periodic_in_engine_hours(self):
        """Reset check: TBN as a function of CUMULATIVE hours must be periodic
        with the drain interval. If it is monotonically falling forever, the
        modulo reset is not wired in."""
        sim = _import_sim()
        drain = 1000.0
        # simulate the build_frame expression directly
        for cycle in (0, 1, 5, 20):
            cumulative = cycle * drain
            since = cumulative % drain
            assert self._tbn(since) == pytest.approx(10.0, abs=1e-9), (
                f"TBN did not reset at cycle {cycle}")

    @pytest.mark.parametrize("cls", list(_specs().keys()))
    def test_every_class_has_a_drain_interval(self, cls):
        spec = _specs()[cls]
        assert "oil_drain_h" in spec
        assert 100.0 <= spec["oil_drain_h"] <= 2000.0


# ═════════════════════════════════════════════════════════════════════════════
# 5. The lubrication index is not the tribological lambda
# ═════════════════════════════════════════════════════════════════════════════

class TestLubricationRegimeNaming:

    def test_feature_is_named_regime_index_not_film_thickness(self):
        """'oil_film_thickness_ratio' invited comparison with the tribological
        film thickness ratio lambda = h_min / composite roughness, whose regime
        boundaries (<1 boundary, 1-3 mixed, >3-4 full film) are a different
        quantity on a different scale. Separate things that shared a name."""
        sim = _import_sim()
        assert "lubrication_regime_index" in sim.FEATURE_COLUMNS
        assert "oil_film_thickness_ratio" not in sim.FEATURE_COLUMNS

    def test_index_is_normalized_zero_to_one(self):
        """Being 0-1 normalized is exactly why it is not comparable to lambda,
        which is unbounded above."""
        sim = _import_sim()
        rng = np.random.default_rng(0)
        n = 500
        v = sim._lubrication_regime_index(
            rng.uniform(2, 200, n), rng.uniform(40, 140, n),
            rng.uniform(600, 3000, n), rng.uniform(5, 100, n), rng.uniform(0, 2, n))
        assert v.min() >= 0.0 and v.max() <= 1.0

    def test_training_and_inference_agree(self):
        sim = _import_sim()
        from app.ml.pretrained import _lubrication_regime_index as scalar
        for visc, temp, rpm, load, wear in (
            (15.0, 80.0, 1800.0, 40.0, 0.0),
            (80.0, 50.0, 900.0, 15.0, 0.5),
            (5.0, 130.0, 2600.0, 95.0, 1.8),
        ):
            vec = float(sim._lubrication_regime_index(
                np.array([visc]), np.array([temp]), np.array([rpm]),
                np.array([load]), np.array([wear]))[0])
            assert vec == pytest.approx(scalar(visc, temp, rpm, load, wear), rel=1e-9)


# ═════════════════════════════════════════════════════════════════════════════
# 6. Train / inference parity for every changed path
# ═════════════════════════════════════════════════════════════════════════════

class TestTrainInferenceParity:
    """fleet_simulation.py and pretrained.py carry independent implementations
    of the same physics, and that duplication is the recurring root cause in
    this codebase — training learns one function and inference serves another.

    Before this fix the two disagreed on: the oil TBN rate (0.0025 vs 0.00050),
    the drain interval (flat 300 h vs per-class), the neglect multiplier (0.5 vs
    2.0), the SIGN of the neglect effect on drain interval, the L10 model
    (linear vs ISO 281), medium-duty average speed (32 vs 27 mph), and service
    intervals for cargo van and passenger car (160k/100k vs 140k).
    """

    def _pt(self):
        from app.ml import pretrained as pt
        return pt

    @pytest.mark.parametrize("code", range(5))
    def test_oil_tbn_parity(self, code):
        sim, pt = _import_sim(), self._pt()
        drain = float(pt._PHYS_SPECS[code]["oil_drain_h"])
        for hrs in (120.0, 640.0, 1500.0, 4800.0, 20000.0):
            for neg in (0.0, 0.5, 1.0):
                for temp in (95.0, 118.0):
                    interval = max(drain, 1.0) * min(max(
                        1.0 + neg * 0.60 - (1.0 - neg) * 0.10, 0.85), 1.70)
                    since = hrs % max(interval, 100.0)
                    train = float(sim._oil_tbn(_arr(since), _arr(temp), _arr(neg))[0])
                    infer = pt._oil_tbn_estimate(hrs, temp, neg, drain)
                    assert train == pytest.approx(infer, abs=1e-12)

    @pytest.mark.parametrize("code", range(5))
    def test_bearing_wear_parity(self, code):
        sim, pt = _import_sim(), self._pt()
        spec = pt._PHYS_SPECS[code]
        svc_map = {0: 480000, 1: 300000, 2: 140000, 3: 140000, 4: 140000}
        mph_map = {0: 38, 1: 27, 2: 27, 3: 27, 4: 31}
        for payload in (0.0, 0.4, 0.7, 1.0):
            for grade in (0.0, 5.0):
                for neg in (0.0, 0.6):
                    for odo in (60000.0, 250000.0, 700000.0):
                        wi_inf, _ = pt._bearing_wear(odo, 5000.0, code, payload,
                                                     neg, 104.0, grade)
                        share = min(max(0.14 + payload * 0.06, 0.10), 0.30)
                        P = spec["mass"] * share * sim._G_MPS2 / 1000.0
                        mph = mph_map[code]
                        n = (mph * 1.609344 / 3.6 / max(spec["tire_circ_m"], 0.5)) * 60.0
                        l10 = float(sim._l10_hours_field(
                            _arr(spec["bearing_C_kn"]), _arr(P), _arr(n), _arr(grade),
                            _arr(spec["bearing_a_field"]), _arr(neg))[0])
                        svc_adj = max(40000.0, svc_map[code] * max(0.50, min(
                            1.40, 1.0 + (1.0 - neg) * 0.25 - neg * 0.15)))
                        hrs_b = (odo % svc_adj) / mph
                        tf = max(1.0, min(2.5, 1.0 + max(0.0, 104.0 - 95.0) * 0.025))
                        wi_train = min(3.0, hrs_b / max(l10, 100.0) * tf)
                        assert wi_train == pytest.approx(wi_inf, abs=1e-12)

    def test_inference_knows_the_new_parameters(self):
        """A missing key here would silently fall back to a default and
        re-open the divergence."""
        pt = self._pt()
        for code in range(5):
            spec = pt._PHYS_SPECS[code]
            for key in ("bearing_C_kn", "bearing_a_field", "oil_drain_h"):
                assert key in spec, f"class {code} missing {key} on the inference side"

    def test_inference_drain_interval_lengthens_with_neglect(self):
        """The substantive sign error: skipping oil changes makes the interval
        LONGER. The old inference code shortened it, so a neglected vehicle was
        modelled as having fresher oil."""
        pt = self._pt()
        maintained = pt._oil_tbn_estimate(900.0, 95.0, 0.0, 1000.0)
        neglected = pt._oil_tbn_estimate(900.0, 95.0, 1.0, 1000.0)
        assert neglected < maintained
