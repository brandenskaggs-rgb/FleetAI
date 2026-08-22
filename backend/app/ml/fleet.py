"""
Cross-fleet normalization for Fleet AI ML pipeline.
Compares a single vehicle's metric distribution against the fleet-wide
mean/std fetched from the Baseline table.
"""
from __future__ import annotations
import math
import logging
from typing import Optional

from ..db import pg as pg_db

logger = logging.getLogger(__name__)

# How many sigma before we consider a vehicle an outlier (used for clamping)
_OUTLIER_SIGMA = 4.0
_CONTEXT_ONLY_METRICS = {"vehicleSpeed", "fuelLevel"}


def _z_to_percentile(z: float) -> float:
    """Approximate CDF of standard normal — no scipy dependency."""
    # Abramowitz & Stegun approximation, accurate to ~1e-4
    sign = 1.0 if z >= 0 else -1.0
    z = abs(z)
    t = 1.0 / (1.0 + 0.2316419 * z)
    poly = t * (0.319381530
                + t * (-0.356563782
                       + t * (1.781477937
                              + t * (-1.821255978
                                     + t * 1.330274429))))
    p = 1.0 - (1.0 / math.sqrt(2 * math.pi)) * math.exp(-0.5 * z * z) * poly
    return p if sign > 0 else 1.0 - p


def _fleet_z(vehicle_mean: float, fleet_mean: float, fleet_std: float) -> float:
    """Z-score of vehicle mean vs fleet distribution."""
    if fleet_std < 1e-9:
        return 0.0
    return (vehicle_mean - fleet_mean) / fleet_std


async def compute_fleet_normalization(
    vehicle_id: str,
    window_stats: dict,  # from features.extract_features()["window_stats"]
) -> dict:
    """
    For each METRIC_KEY, fetch fleet-wide stats and compute:
      - z_score: how many σ above/below fleet mean
      - percentile: 0-100 position in the fleet
      - deviation_label: "normal" / "elevated" / "high" / "critical"
      - fleet_vehicles: how many vehicles contributed to the fleet baseline

    Returns:
      {
        "metric_key": {
          "vehicle_mean": float,
          "fleet_mean": float,
          "fleet_std": float,
          "z_score": float,
          "percentile": float,       # 0-100
          "deviation_label": str,
          "fleet_vehicles": int,
        },
        ...
        "_summary": {
          "metrics_above_fleet": int,   # z > 1
          "metrics_critical": int,      # z > 2
          "worst_metric": str | None,
          "worst_z": float,
        }
      }
    """
    result: dict = {}
    metrics_above = 0
    metrics_critical = 0
    worst_metric: Optional[str] = None
    worst_z = 0.0
    worst_percentile = 50.0  # 0-100 scale, matches per-metric "percentile" below

    # Pull only the 24h window mean per metric to compare against fleet baseline
    for metric_key, stats_by_window in window_stats.items():
        h24_stats = stats_by_window.get("h24", {})
        vehicle_mean = h24_stats.get("mean")
        if vehicle_mean is None:
            # Fall back to all-time mean
            vehicle_mean = stats_by_window.get("all", {}).get("mean")
        if vehicle_mean is None:
            continue

        try:
            fleet_data = await pg_db.get_fleet_baselines(metric_key)
        except Exception as exc:
            logger.debug(f"[fleet] fleet baseline fetch failed for {metric_key}: {exc}")
            fleet_data = {}

        if not fleet_data:
            result[metric_key] = {
                "vehicle_mean": round(vehicle_mean, 4),
                "fleet_mean": None,
                "fleet_std": None,
                "z_score": None,
                "percentile": None,
                "deviation_label": "no_fleet_data",
                "fleet_vehicles": 0,
            }
            continue

        fleet_mean = fleet_data["fleet_mean"]
        fleet_std = fleet_data["fleet_std"]
        fleet_vehicles = fleet_data["vehicle_count"]

        z = _fleet_z(vehicle_mean, fleet_mean, fleet_std)
        z_clamped = max(-_OUTLIER_SIGMA, min(_OUTLIER_SIGMA, z))
        percentile = round(_z_to_percentile(z_clamped) * 100, 1)

        if z > 3.0:
            label = "critical"
        elif z > 2.0:
            label = "high"
        elif z > 1.0:
            label = "elevated"
        elif z < -2.0:
            label = "low"
        else:
            label = "normal"

        if metric_key not in _CONTEXT_ONLY_METRICS:
            if z > 1.0:
                metrics_above += 1
            if z > 2.0:
                metrics_critical += 1
            if abs(z) > abs(worst_z):
                worst_z = z
                worst_metric = metric_key
                worst_percentile = percentile

        result[metric_key] = {
            "vehicle_mean": round(vehicle_mean, 4),
            "fleet_mean": round(fleet_mean, 4),
            "fleet_std": round(fleet_std, 4),
            "z_score": round(z, 3),
            "percentile": percentile,
            "deviation_label": label,
            "fleet_vehicles": fleet_vehicles,
        }

    result["_summary"] = {
        "metrics_above_fleet": metrics_above,
        "metrics_critical": metrics_critical,
        "worst_metric": worst_metric,
        "worst_z": round(worst_z, 3),
        # Stage 2 (stage2.py) and the stacking meta-learner (stack.py) both
        # read this as a 0-1 fraction (their fallback is 0.5, i.e. "50th
        # percentile of 1.0") — divide the 0-100 per-metric scale used above.
        "fleet_percentile": round(worst_percentile / 100.0, 4),
    }
    return result


def fleet_risk_boost(fleet_norm: dict) -> float:
    """
    Derive a 0-1 risk multiplier from fleet normalization results.
    Used to amplify ensemble score when vehicle is a fleet outlier.
    """
    summary = fleet_norm.get("_summary", {})
    critical = summary.get("metrics_critical", 0)
    above = summary.get("metrics_above_fleet", 0)
    worst_z = abs(summary.get("worst_z", 0.0))

    # Scale: 0 critical → boost 0; 3+ critical → boost 0.25 cap
    boost = min(0.25, (critical * 0.08) + (above * 0.02) + (max(0, worst_z - 2) * 0.03))
    return round(boost, 4)
