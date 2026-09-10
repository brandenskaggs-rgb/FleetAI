"""Report integrity tests; no training, artifact replacement, or live data access."""
import json
import importlib.util
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

spec = importlib.util.spec_from_file_location(
    "realworld_training_under_test",
    Path(__file__).resolve().parents[1] / "fleet_ai/training/train_real_world.py",
)
training = importlib.util.module_from_spec(spec)
spec.loader.exec_module(training)
BASE_FEATURES, evaluate, infer_label, train = (
    training.BASE_FEATURES, training.evaluate, training.infer_label, training.train
)


@pytest.mark.parametrize("label", [0, 1])
def test_one_class_report_is_strict_json(label):
    report = evaluate(np.array([label]), np.array([0.4]), 0.5)
    assert report["roc_auc"] is None
    assert report["pr_auc"] is None
    assert report["evaluation_status"] == "insufficient_label_diversity"
    json.dumps(report, allow_nan=False)


def test_two_class_report_keeps_valid_auc():
    report = evaluate(np.array([0, 1]), np.array([0.1, 0.9]), 0.5)
    assert report["roc_auc"] == 1.0
    json.dumps(report, allow_nan=False)


@pytest.mark.parametrize("label", [None, 0.5, -1, 2, "unknown"])
def test_invalid_labels_are_not_coerced(label):
    with pytest.raises(ValueError, match="labels must be"):
        infer_label(pd.DataFrame({"failure": [label]}))


def test_tiny_run_does_not_export_model(tmp_path, monkeypatch):
    def unexpected_export(*args, **kwargs):
        pytest.fail("Insufficient run attempted model export")
    monkeypatch.setattr(training.joblib, "dump", unexpected_export)
    rows = [{**{feature: 1.0 for feature in BASE_FEATURES},
             "truck_id": "fixture", "timestamp": f"2026-01-0{i+1}", "failure": i % 2}
            for i in range(3)]
    path = tmp_path / "fixture.csv"
    pd.DataFrame(rows).to_csv(path, index=False)
    with pytest.raises(ValueError, match="outcome_confirmed"):
        train(path)
