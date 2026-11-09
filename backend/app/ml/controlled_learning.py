"""Confirmed-outcome component learning. Never trains on LLM answers or unlabeled drives.

Uses immutable production feature snapshots, not retrospective vehicle metadata.
The existing ensemble remains authoritative; promoted component models are separate
evidence until a distinct field study justifies changing ensemble weights.
"""
from __future__ import annotations
import hashlib
import json
import math
from datetime import datetime, timezone

from .feature_contract import PRETRAINED_FEATURES, manifest, epoch, finite, json_safe, vector

VERSION = "confirmed-component-v1"
SOURCE = "real_confirmed_outcomes"
COMPONENTS = {"charging", "cooling", "fuel", "engine", "emissions", "drivetrain", "brakes", "tires", "bearings", "sensor"}
TARGET_SENSORS = {
    "charging": ["battery_voltage"], "cooling": ["engine_temp"],
    "fuel": ["fuel_pressure", "fuel_rate"], "engine": ["rpm", "oil_pressure", "oil_temp"],
    "emissions": ["dpf_soot_load", "egr_flow_rate", "dpf_differential_kpa"],
    "drivetrain": ["transmission_temp", "vibration"], "brakes": ["brake_temp"],
    "tires": ["tire_pressure"], "bearings": ["vibration"],
    "sensor": ["rpm", "engine_temp", "battery_voltage"],
}


def digest(value):
    return hashlib.sha256(json.dumps(json_safe(value), sort_keys=True, allow_nan=False).encode()).hexdigest()


def training_window(samples):
    """Describe the exact input window without duplicating raw telemetry."""
    from .features import _VALID_RANGES
    times = sorted({epoch(s.get("ts")) for s in samples if epoch(s.get("ts")) is not None})
    invalid = sum(epoch(s.get("ts")) is None for s in samples)
    for sample in samples:
        for key, limits in _VALID_RANGES.items():
            raw = (sample.get("metrics") or {}).get(key)
            if raw is not None and (finite(raw) is None or not limits[0] <= finite(raw) <= limits[1]):
                invalid += 1
    return {"version": VERSION, "samples": len(samples), "distinctTimes": len(times),
            "start": datetime.fromtimestamp(times[0], timezone.utc).isoformat() if times else None,
            "end": datetime.fromtimestamp(times[-1], timezone.utc).isoformat() if times else None,
            "maxGapSeconds": max((b-a for a,b in zip(times,times[1:])), default=0),
            "invalidReadings": invalid,
            "timestampFingerprint": digest(times)}


def build_dataset(org_id, outcomes, predictions, *, horizon_days=14):
    if not org_id or horizon_days != 14:
        raise ValueError("Tenant and the versioned 14-day target are required")
    if any(r.get("orgId") != org_id for r in [*outcomes, *predictions]):
        raise ValueError("Cross-tenant learning input rejected")
    runs = {r["id"]: r for r in predictions}
    examples, excluded, seen = [], {}, set()
    for outcome in sorted(outcomes, key=lambda r: r["id"]):
        try:
            e = outcome.get("outcomeEvidence") or {}
            run = runs.get(outcome.get("predictionRunId"))
            if not run or run["vehicleId"] != outcome["vehicleId"]:
                raise ValueError("missing_owned_prediction")
            if e.get("version") != 1 or e.get("component") not in COMPONENTS or not outcome.get("reviewedBy"):
                raise ValueError("unverified_outcome")
            if e.get("source") not in {"technician", "repair_invoice", "inspection", "maintenance_integration"} or not e.get("technicianNotes"):
                raise ValueError("missing_inspection_evidence")
            prediction_time, observed = epoch(run["createdAt"]), epoch(e.get("observedAt"))
            saved = epoch(outcome.get("createdAt"))
            if None in (prediction_time, observed, saved) or not prediction_time < observed <= saved:
                raise ValueError("invalid_outcome_clock")
            horizon = horizon_days * 86400
            failure, normal = e.get("confirmedFailure") is True, e.get("inspectedNormal") is True
            if failure and not normal and outcome["outcome"] == "confirmed_breakdown" and observed <= prediction_time + horizon:
                label, rule = 1, "confirmed_component_failure_within_14d"
            elif normal and not failure and outcome["outcome"] in {"confirmed_normal", "false_positive"}:
                start = epoch(e.get("coverageStart"))
                if start is None or start > prediction_time or observed < prediction_time + horizon:
                    raise ValueError("negative_horizon_not_verified")
                label, rule = 0, "inspected_normal_with_full_14d_coverage"
            else:
                raise ValueError("maintenance_is_not_failure_evidence")
            # Conflicting inspections for the same time/target are not resolved by guessing.
            for other in outcomes:
                oe = other.get("outcomeEvidence") or {}
                if other["id"] == outcome["id"] or other["vehicleId"] != run["vehicleId"] or oe.get("component") != e["component"]:
                    continue
                ot = epoch(oe.get("observedAt"))
                if ot and prediction_time < ot <= prediction_time + horizon and oe.get("confirmedFailure") is True and label == 0:
                    raise ValueError("conflicting_outcomes")
                if other.get("predictionRunId") == run["id"] and oe.get("confirmedFailure") is not failure:
                    raise ValueError("conflicting_outcomes")
            py = (run.get("predictionJson") or {}).get("lineage", {}).get("python") or {}
            lineage = py.get("evidence") or {}
            prior = lineage.get("pretrained") or {}
            row = prior.get("inputFeatures") or {}
            window = lineage.get("trainingWindow") or {}
            if prior.get("schema") != manifest() or any(k not in row for k in PRETRAINED_FEATURES):
                raise ValueError("missing_or_incompatible_feature_snapshot")
            if window.get("version") != VERSION or window.get("invalidReadings") != 0 or window.get("distinctTimes", 0) < 12:
                raise ValueError("insufficient_or_invalid_telemetry")
            start, end = epoch(window.get("start")), epoch(window.get("end"))
            if start is None or end is None or end-start < 60 or not end <= prediction_time <= end+300:
                raise ValueError("stale_or_future_feature_window")
            if window.get("maxGapSeconds", math.inf) > 7*86400:
                raise ValueError("excessive_telemetry_gaps")
            if sum(finite(row.get(k)) is not None for k in ["rpm", "engine_temp", "battery_voltage", "oil_pressure", "fuel_pressure"]) < 2:
                raise ValueError("insufficient_sensor_coverage")
            if not any(finite(row.get(k)) is not None for k in TARGET_SENSORS[e["component"]]):
                raise ValueError("missing_target_sensor_evidence")
            event_key = (run["vehicleId"], e["component"], observed)
            prediction_key = (run["id"], e["component"])
            if event_key in seen or prediction_key in seen:
                raise ValueError("duplicate_outcome")
            seen.update((event_key, prediction_key))
            examples.append({"id": digest(event_key), "org_id": org_id, "vehicle_id": run["vehicleId"],
                "timestamp": run["createdAt"], "observed_at": e["observedAt"], "label_known_at": outcome["createdAt"],
                "label": label, "component": e["component"], "features": {k: finite(row[k]) for k in PRETRAINED_FEATURES},
                "lead_hours": (observed-prediction_time)/3600 if label else None,
                "provenance": {"rule": rule, "outcomeId": outcome["id"], "predictionRunId": run["id"],
                    "modelVersion": run.get("modelVersion"), "source": e["source"],
                    "snapshotHash": digest(prior), "window": window, "physicsAssumptions": prior.get("assumedSensorInputs"),
                    "evidenceSource": SOURCE, "labelConfidence": "human_confirmed_not_independently_adjudicated"}})
        except ValueError as exc:
            key = str(exc)
            excluded[key] = excluded.get(key, 0) + 1
    metadata = {"version": VERSION, "orgId": org_id, "featureSchema": manifest(), "horizonDays": horizon_days,
        "source": SOURCE, "outcomesReviewed": len(outcomes), "examples": len(examples), "excluded": excluded,
        "featurePolicy": "recorded_production_inputs_not_retroactive_reconstruction"}
    identifier = digest({"manifest": metadata, "examples": examples})
    return identifier, metadata, examples


def independent_parts(examples):
    import pandas as pd
    from .evaluation import partition
    frame = pd.DataFrame(examples)
    frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True)
    parts = partition(frame)
    # A repair entered late was not available to the earlier training operation.
    purged = []
    for part in parts:
        known = pd.to_datetime(part["label_known_at"], utc=True)
        purged.append(part.loc[known <= part["timestamp"].max()].copy())
    if any(len(p) < 10 or set(p.label) != {0, 1} for p in purged):
        raise ValueError("Insufficient independent vehicles, mature outcomes or both-class partitions")
    return tuple(purged)


def score_bundle(bundle, examples):
    import numpy as np
    from .feature_contract import validate_bundle_schema
    validate_bundle_schema(bundle)
    x = np.array([vector(r, PRETRAINED_FEATURES) for r in examples], dtype=float)
    p = bundle["model"].predict_proba(x)[:, 1]
    cal = bundle.get("calibrator")
    if cal is not None and bundle.get("artifactId"):
        bound = bundle.get("calibration") or {}
        if bound.get("artifactId") != bundle["artifactId"] or bound.get("modelVersion") != bundle.get("metadata", {}).get("datasetVersion"):
            raise ValueError("Calibration is not bound to this model/dataset")
    if cal is not None and (bundle.get("calibration") or {}).get("status") == "calibrated":
        p = cal.predict(p)
    return p


def train_candidate(registry, dataset_id, org_id, component, *, git_version, policy=None):
    import numpy as np
    import pandas as pd
    from sklearn.ensemble import HistGradientBoostingClassifier
    from .evaluation import metrics, promotion_gates, fit_calibration
    if component not in COMPONENTS or not git_version:
        raise ValueError("Known target and source revision required")
    scope, slot = "tenant:" + org_id, "component:" + component
    metadata, examples = registry.dataset(dataset_id, scope)
    if metadata["featureSchema"] != manifest():
        raise ValueError("Dataset feature implementation has changed")
    selected = [r for r in examples if r["component"] == component]
    train, validation, test = independent_parts(selected)
    model = HistGradientBoostingClassifier(max_iter=200, max_depth=6, learning_rate=.05, random_state=42, early_stopping=False)
    matrix = lambda p: np.array([vector(r, PRETRAINED_FEATURES) for r in p.features], dtype=float)
    model.fit(matrix(train), train.label)
    # Separate calibration and threshold-selection vehicles; otherwise stay uncalibrated.
    calibration, cal_meta = None, {"status": "uncalibrated", "reason": "insufficient_independent_calibration", "fieldValidated": False}
    selection = validation
    groups = sorted(validation.vehicle_id.unique())
    if len(groups) >= 2:
        cutoff = validation.timestamp.median()
        cal = validation.loc[validation.vehicle_id.isin(groups[:len(groups)//2]) & (validation.timestamp <= cutoff)]
        cal = cal.loc[pd.to_datetime(cal.label_known_at, utc=True) <= cutoff]
        proposed = validation.loc[~validation.vehicle_id.isin(groups[:len(groups)//2]) & (validation.timestamp > cutoff)]
        if len(cal) >= 200 and set(proposed.label) == {0, 1}:
            calibration, cal_meta = fit_calibration(cal.label, model.predict_proba(matrix(cal))[:, 1], SOURCE, dataset_id)
            selection = proposed
    bundle = {"model": model, "features": PRETRAINED_FEATURES, "feature_schema": manifest(),
              "calibrator": calibration, "calibration": cal_meta, "target": component, "horizonDays": 14}
    val_p = score_bundle(bundle, selection.features)
    # Policy is fixed before opening the final test; threshold uses validation only.
    thresholds = [(float(t), metrics(selection.label, val_p, float(t), SOURCE)) for t in np.arange(.05, .96, .05)]
    threshold, validation_metrics = max(thresholds, key=lambda pair: (pair[1]["f1"], -pair[0]))
    active = registry.load_active(slot, scope)
    baseline_id = active.get("artifactId") if active else None
    # Enforce prospective comparison: the active model must not have seen this holdout.
    if active and (set(active.get("metadata", {}).get("fitOutcomeIds", [])) & set(test.id)):
        raise ValueError("Active model has seen candidate holdout outcomes")
    if active:
        fit_through = epoch(active.get("metadata", {}).get("fitThrough"))
        if fit_through is None or fit_through >= test.timestamp.min().timestamp():
            raise ValueError("Active model lacks prospective holdout independence")
        fit_vehicles = active.get("metadata", {}).get("fitVehicleIds")
        if not fit_vehicles or set(fit_vehicles) & set(test.vehicle_id):
            raise ValueError("Active model lacks vehicle-disjoint holdout independence")
    bundle["threshold"] = threshold
    identifier = registry.candidate(slot, bundle, {"modelVersion": dataset_id, "trainingSource": SOURCE,
        "featureSchema": manifest(), "datasetVersion": dataset_id, "target": component, "horizonDays": 14,
        "gitVersion": git_version, "hyperparameters": model.get_params(), "calibration": cal_meta,
        "fitThrough": max(pd.to_datetime(train.label_known_at, utc=True).max(), pd.to_datetime(validation.label_known_at, utc=True).max()).isoformat(),
        "fitOutcomeIds": list(train.id) + list(validation.id), "testOutcomeIds": list(test.id),
        "fitVehicleIds": sorted(set(train.vehicle_id) | set(validation.vehicle_id)),
        "trainingMetrics": metrics(train.label, score_bundle(bundle, train.features), threshold, SOURCE),
        "validationMetrics": validation_metrics}, scope=scope)
    registry.reserve_test(scope, slot, identifier, list(test.id))
    final = metrics(test.label, score_bundle(bundle, test.features), threshold, SOURCE, test.lead_hours)
    baseline = metrics(test.label, score_bundle(active, test.features), active["threshold"], SOURCE, test.lead_hours) if active else None
    gates = promotion_gates(final, baseline, policy)
    per_vehicle = {}
    for vehicle_id, group in test.groupby("vehicle_id"):
        if len(group) >= 10 and set(group.label) == {0, 1}:
            per_vehicle[vehicle_id] = metrics(group.label, score_bundle(bundle, group.features), threshold, SOURCE, group.lead_hours)
    report = {"partition": "untouched_test", "evidenceSource": SOURCE, "datasetVersion": dataset_id,
        "metrics": final, "validationMetrics": validation_metrics, "baselineArtifactId": baseline_id,
        "baselineMetrics": baseline, "gatePolicy": gates["policy"], "gates": gates, "byVehicle": per_vehicle,
        "comparison": "same_target_same_holdout" if active else "no_active_component_model_bootstrap",
        "fieldValidated": False, "rowsPurged": len(selected)-len(train)-len(validation)-len(test)}
    registry.evaluate(identifier, report)
    return {"candidateId": identifier, "report": report, "promoted": False}


def component_evidence(org_id, features):
    """Read only active tenant artifacts. Failure cannot interrupt the original ensemble."""
    from .artifact_registry import configured_registry
    registry = configured_registry()
    if registry is None:
        return {"status": "disabled_without_persistent_registry", "results": []}
    results = []
    for component in sorted(COMPONENTS):
        bundle = registry.load_active("component:" + component, "tenant:" + org_id)
        if bundle is None:
            continue
        if bundle.get("metadata", {}).get("trainingSource") != SOURCE:
            raise ValueError("Unexpected component training source")
        if not any(finite(features.get(k)) is not None for k in TARGET_SENSORS[component]):
            results.append({"component": component, "artifactId": bundle["artifactId"], "riskProbability": None,
                            "status": "insufficient_target_sensor_evidence"})
            continue
        probability = float(score_bundle(bundle, [features])[0])
        results.append({"component": component, "riskProbability": probability, "horizonDays": 14,
            "artifactId": bundle["artifactId"], "datasetVersion": bundle["metadata"]["datasetVersion"],
            "trainingSource": SOURCE, "calibration": bundle.get("calibration"),
            "interpretation": "separate_component_evidence_not_combined_ensemble_probability"})
    return {"status": "active" if results else "no_promoted_component_models", "results": results}
