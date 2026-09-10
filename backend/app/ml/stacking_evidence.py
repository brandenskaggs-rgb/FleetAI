"""Generate upstream evidence without fitting on the scored observations.

Callbacks must fit fresh instances of the actual upstream pipeline (including
its imputers, baselines and calibration) using only the supplied training frame.
Call with the OUTER TRAIN partition only, never a final evaluation dataset.
"""
from __future__ import annotations
import hashlib
import json
import pandas as pd


def fingerprint(values):
    return hashlib.sha256(json.dumps(sorted(map(str, values))).encode()).hexdigest()


def generate_oof(frame, folds, fit_upstream, predict_upstream, *, group="vehicle_id", time="timestamp"):
    if not frame.index.is_unique or frame[group].isna().any():
        raise ValueError("OOF evidence needs unique examples and known vehicle groups")
    ts = pd.to_datetime(frame[time], utc=True, errors="raise")
    if ts.isna().any():
        raise ValueError("OOF evidence requires observed timestamps")
    scored = set()
    output = []
    for fold, (train_ids, score_ids) in enumerate(folds):
        train_ids, score_ids = list(train_ids), list(score_ids)
        if not train_ids or not score_ids or set(train_ids) & set(score_ids) or scored & set(score_ids):
            raise ValueError("OOF partitions overlap or are empty")
        train, score = frame.loc[train_ids], frame.loc[score_ids]
        if set(train[group]) & set(score[group]):
            raise ValueError("Upstream model saw a scored vehicle")
        if ts.loc[train_ids].max() >= ts.loc[score_ids].min():
            raise ValueError("Upstream model saw future observations")
        model = fit_upstream(train.copy())
        predictions = predict_upstream(model, score.copy())
        if len(predictions) != len(score):
            raise ValueError("One upstream result is required per scored observation")
        for index, result in zip(score_ids, predictions):
            output.append({"example_id": index, "features": result,
                "provenance": {"source": "real_oof", "fold": fold,
                    "fitExamplesHash": fingerprint(train_ids), "fitVehiclesHash": fingerprint(train[group].unique()),
                    "fitThrough": ts.loc[train_ids].max().isoformat(), "scoredAt": ts.loc[index].isoformat(),
                    "groupDisjoint": True, "outerPartition": "train"}})
        scored.update(score_ids)
    return output


def require_oof(row):
    p = row.get("provenance") or {}
    fit_time = pd.to_datetime(p.get("fitThrough"), utc=True, errors="coerce")
    score_time = pd.to_datetime(p.get("scoredAt"), utc=True, errors="coerce")
    if (p.get("source") != "real_oof" or p.get("outerPartition") != "train"
            or not p.get("groupDisjoint") or not p.get("fitExamplesHash")
            or pd.isna(fit_time) or pd.isna(score_time) or fit_time >= score_time):
        raise ValueError("Real stacking requires actual group-disjoint, forward OOF evidence")
