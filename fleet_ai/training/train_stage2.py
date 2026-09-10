"""Train LightGBM candidates; test data never controls early stopping."""
from __future__ import annotations
import argparse
import sys
from pathlib import Path
import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.model_selection import train_test_split
from sklearn.model_selection import GroupShuffleSplit
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from backend.app.ml.feature_contract import STAGE2_FEATURES, manifest
from backend.app.ml.evaluation import partition, metrics, fit_calibration, binary_labels
from backend.app.ml.artifact_registry import training_registry

DATA_PATH = Path(__file__).resolve().parents[1] / "models" / "fleet_ai_stage2_training.parquet"


def train_frame(df, *, source="synthetic_proxy_stacking", registry=None, scope="global_synthetic"):
    missing = set(STAGE2_FEATURES) - set(df.columns)
    if missing:
        raise ValueError("Missing Stage 2 schema columns: " + ", ".join(sorted(missing)))
    binary_labels(df["label"])
    if not source.startswith("synthetic"):
        # Production predictions do not prove OOF provenance. Real training must
        # arrive through a reviewed upstream replay/export with outer splits.
        raise ValueError("Real Stage 2 promotion is blocked pending validated upstream OOF replay integration")
    if "vehicle_id" in df:
        train_df, val_df, test_df = partition(df, chronological=False)
        split_kind = "vehicle_disjoint_synthetic"
    else:
        train_df, rest = train_test_split(df, test_size=.4, random_state=42, stratify=df["label"])
        val_df, test_df = train_test_split(rest, test_size=.5, random_state=43, stratify=rest["label"])
        split_kind = "legacy_synthetic_rows_only_no_group_generalization_claim"
    # Reserve calibration examples before early stopping. No examples from test
    # or calibration are exposed to the boosting fit.
    def split_validation(part, fraction, seed):
        if "vehicle_id" in part:
            if part.vehicle_id.nunique() < 2:
                raise ValueError("More independent validation vehicles are required")
            left, right = next(GroupShuffleSplit(n_splits=1, test_size=fraction, random_state=seed).split(part, groups=part.vehicle_id))
            return part.iloc[left], part.iloc[right]
        return train_test_split(part, test_size=fraction, random_state=seed, stratify=part["label"])
    select_df, calibration_pool = split_validation(val_df, .6, 44)
    cal_df, conformal_df = split_validation(calibration_pool, .5, 45)
    def X(part):
        return part[list(STAGE2_FEATURES)].to_numpy(dtype=np.float32)
    model = lgb.LGBMClassifier(n_estimators=300, learning_rate=.04, num_leaves=31,
        max_depth=6, min_child_samples=20, subsample=.85, colsample_bytree=.85,
        class_weight="balanced", reg_alpha=.05, reg_lambda=.10, random_state=42, verbose=-1, n_jobs=2)
    model.fit(X(train_df), train_df["label"].to_numpy(),
              eval_set=[(X(select_df), select_df["label"].to_numpy())],
              callbacks=[lgb.early_stopping(50, verbose=False)])
    version = "stage2-v2-candidate"
    cal, calibration = fit_calibration(cal_df["label"], model.predict_proba(X(cal_df))[:,1], source, version)
    from backend.app.ml.conformal import ConformalPredictor
    conformal = ConformalPredictor()
    conformal_probs = model.predict_proba(X(conformal_df))[:,1]
    if cal is not None:
        conformal_probs = cal.predict(conformal_probs)
    conformal.fit(conformal_probs.tolist(), conformal_df["label"].tolist(), metadata={
        "modelVersion": version, "source": source, "partition": "independent_conformal", "fieldValidated": False})
    probability = model.predict_proba(X(test_df))[:,1]
    if cal is not None:
        probability = cal.predict(probability)
    report = {"partition": "untouched_test", "evidenceSource": source, "split": split_kind,
        "trainRows": len(train_df), "selectionRows": len(select_df), "calibrationRows": len(cal_df),
        "testRows": len(test_df), "conformalRows": len(conformal_df), "metrics": metrics(test_df["label"], probability, .5, source),
        "calibration": calibration, "realWorldAccuracyEstablished": False}
    metadata = {"modelVersion": version, "trainingSource": source,
        "featureSchema": manifest(STAGE2_FEATURES), "calibration": calibration,
        "stackingEvidence": "synthetic_upstream_proxies_not_real_oof"}
    bundle = {"model": model, "features": list(STAGE2_FEATURES), "calibrator": cal,
        "calibration": calibration, "train_sample_count": len(train_df),
        "feedback_samples": 0, "metrics": report["metrics"], "conformal": conformal.to_bundle()}
    registry = registry or training_registry()
    identifier = registry.candidate("stage2", bundle, metadata, scope=scope)
    registry.evaluate(identifier, report)
    return identifier, report


def train(generate_data=False, n_seeds=50, sample_per_seed=5000, data_path=None):
    path = Path(data_path) if data_path else DATA_PATH
    if generate_data:
        from fleet_ai.training.fleet_simulation import generate_stage2_training_data
        generated = generate_stage2_training_data(n_seeds=n_seeds, sample_per_seed=sample_per_seed)
        if isinstance(generated, pd.DataFrame):
            frame = generated
        else:
            raise ValueError("Generator must return its new frame without replacing existing data")
    else:
        frame = pd.read_parquet(path)
    identifier, report = train_frame(frame)
    print(f"Evaluated candidate: {identifier}; active model unchanged")
    print(f"Synthetic test rows: {report['testRows']}; F1: {report['metrics']['f1']:.4f}")
    return identifier, report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--generate-data", action="store_true")
    parser.add_argument("--n-seeds", type=int, default=50)
    parser.add_argument("--sample-per-seed", type=int, default=5000)
    parser.add_argument("--data", type=Path)
    args = parser.parse_args()
    train(args.generate_data, args.n_seeds, args.sample_per_seed, args.data)
