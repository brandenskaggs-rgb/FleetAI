"""Replay simulated observations through the production pretrained input builder.

The simulator still generates physics and synthetic outcomes. Latent failure
variables and simulated upstream scores are NOT passed as observed inputs.
"""
from __future__ import annotations
import numpy as np
import pandas as pd
from backend.app.ml.feature_contract import SENSOR_FEATURES, PRETRAINED_FEATURES, TEMPORAL_KEYS, DELTA_FEATURES, time_features, finite
from backend.app.ml.pretrained import PretrainedScorer
from backend.app.ml.features import metric_value

METRIC_COLUMNS = {value: key for key, value in SENSOR_FEATURES.items()}
METRIC_COLUMNS.update({"hubTempFL": "hub_temp_fl_c", "hubTempFR": "hub_temp_fr_c",
                      "hubTempRL": "hub_temp_rl_c", "hubTempRR": "hub_temp_rr_c",
                      "bearingFreqScore": "bearing_freq_score", "turboBearingTemp": "turbo_bearing_temp"})


def canonical_training_frame(frame):
    if "timestamp" not in frame or "vehicle_id" not in frame:
        raise ValueError("Canonical training requires vehicle identity and actual observation timestamps")
    observed = frame.reset_index(drop=True).copy()
    for key, col in METRIC_COLUMNS.items():
        if col in observed:
            observed[col] = observed[col].map(lambda value: metric_value({"metrics": {key: value}}, key))
    data = time_features(observed, "vehicle_id", "timestamp", METRIC_COLUMNS)
    result = data.copy()
    scorer = PretrainedScorer()
    for _, group in data.groupby("vehicle_id", sort=False):
        stats = {}
        for key, col in METRIC_COLUMNS.items():
            if col in group:
                series = group.set_index("timestamp")[col]
                rolling = series.rolling("24h", closed="both")
                spread = rolling.std(ddof=1).mask(rolling.count() == 1, 0)
                stats[key] = (series.expanding().mean().round(4).to_numpy(),
                              rolling.mean().round(4).to_numpy(), spread.round(4).to_numpy())
        for offset, (index, record) in enumerate(group.iterrows()):
            cm = {key: record.get(col) for key, col in METRIC_COLUMNS.items()
                  if col in group and pd.notna(record.get(col))}
            ws = {key: {"all": {"mean": finite(pair[0][offset])}, "h24": {"mean": finite(pair[1][offset]), "std": finite(pair[2][offset])}}
                  for key, pair in stats.items()}
            meta = {"vehicleClass": record.get("vehicle_class"), "make": record.get("make"),
                    "powertrain": record.get("powertrain"), "year": record.get("model_year"),
                    "odometer": record.get("odometer_miles"), "engineHours": record.get("engine_hours")}
            meta = {k: v for k, v in meta.items() if v is not None and pd.notna(v)}
            flat = {key: record.get(key) for key in [*(f"{k}_accel_h24" for k in TEMPORAL_KEYS), *DELTA_FEATURES]}
            row, _ = scorer.build_input(cm, ws, meta, flat)
            result.loc[index, PRETRAINED_FEATURES] = [row.get(k, np.nan) for k in PRETRAINED_FEATURES]
    return result
