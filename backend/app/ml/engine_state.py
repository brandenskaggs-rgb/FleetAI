"""Event-time engine transition classification and ML sample filtering."""
from __future__ import annotations

import math
from bisect import bisect_left
from datetime import datetime, timezone
from typing import Any, Optional


DEFAULTS = {
    "running_rpm": 400.0,
    "off_rpm": 100.0,
    "stopped_speed_kph": 3.0,
    "moving_speed_kph": 8.0,
    "max_transition_gap_seconds": 60.0,
    "confirmation_window_seconds": 90.0,
    "context_window_seconds": 60.0,
    "adjacent_running_window_seconds": 15.0,
    "minimum_off_confirmations": 2,
    "minimum_idle_samples": 4,
    "minimum_baseline_idle_samples": 12,
}


def _number(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):
        return None


def _timestamp(sample: dict) -> Optional[float]:
    raw = sample.get("ts") or sample.get("timestamp")
    if not raw:
        return None
    try:
        parsed = raw if isinstance(raw, datetime) else datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except (TypeError, ValueError):
        return None


def _iso(value: Optional[float]) -> Optional[str]:
    if value is None:
        return None
    return datetime.fromtimestamp(value, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _metric(sample: dict, key: str) -> Optional[float]:
    metrics = sample.get("metrics") if isinstance(sample.get("metrics"), dict) else {}
    return _number(metrics.get(key))


def _ordered(samples: list[dict]) -> list[dict]:
    result = []
    for sample in samples or []:
        at = _timestamp(sample)
        if at is not None:
            result.append({"sample": sample, "at": at})
    return sorted(result, key=lambda item: item["at"])


def _stats(values: list[float]) -> dict:
    valid = [value for value in (_number(item) for item in values) if value is not None]
    if not valid:
        return {"count": 0, "mean": None, "std": None, "min": None, "max": None}
    mean = sum(valid) / len(valid)
    variance = sum((value - mean) ** 2 for value in valid) / len(valid)
    return {
        "count": len(valid),
        "mean": round(mean, 1),
        "std": round(math.sqrt(variance), 1),
        "min": min(valid),
        "max": max(valid),
    }


def _result(status: str, **overrides: Any) -> dict:
    result = {
        "status": status,
        "confidence": 0.0,
        "alertable": False,
        "occurredAt": None,
        "lastRunningAt": None,
        "gapSeconds": None,
        "evidence": {},
    }
    result.update(overrides)
    return result


def classify_engine_event(samples: list[dict], **options: Any) -> dict:
    """Classify the current engine state using device timestamps, never DB arrival time."""
    cfg = {**DEFAULTS, **options}
    points = []
    for item in _ordered(samples):
        rpm = _metric(item["sample"], "rpm")
        if rpm is None:
            continue
        state = "running" if rpm >= cfg["running_rpm"] else "off" if rpm <= cfg["off_rpm"] else "transition"
        points.append({**item, "rpm": rpm, "state": state})

    if not points:
        return _result("insufficient_data")
    latest = points[-1]
    if latest["state"] == "running":
        return _result(
            "engine_running",
            confidence=0.99,
            lastRunningAt=_iso(latest["at"]),
            evidence={"rpm": latest["rpm"], "speedKph": _metric(latest["sample"], "vehicleSpeed")},
        )
    if latest["state"] != "off":
        return _result("transition_unknown", confidence=0.35, evidence={"rpm": latest["rpm"]})

    off_start = len(points) - 1
    while off_start > 0 and points[off_start - 1]["state"] == "off":
        off_start -= 1
    first_off = points[off_start]
    running_index = off_start - 1
    while running_index >= 0 and points[running_index]["state"] != "running":
        running_index -= 1
    if running_index < 0:
        return _result(
            "off_state_unknown",
            confidence=0.55,
            occurredAt=_iso(first_off["at"]),
            evidence={"offConfirmations": len(points) - off_start},
        )

    last_running = points[running_index]
    gap = first_off["at"] - last_running["at"]
    confirmations = sum(
        1 for point in points[off_start:]
        if point["state"] == "off" and point["at"] - first_off["at"] <= cfg["confirmation_window_seconds"]
    )
    common_evidence = {
        "lastRunningRpm": last_running["rpm"],
        "lastRunningSpeedKph": _metric(last_running["sample"], "vehicleSpeed"),
        "firstOffSpeedKph": _metric(first_off["sample"], "vehicleSpeed"),
        "lastRunningBatteryVoltage": _metric(last_running["sample"], "batteryVoltage"),
        "offConfirmations": confirmations,
    }
    common = {
        "occurredAt": _iso(first_off["at"]),
        "lastRunningAt": _iso(last_running["at"]),
        "gapSeconds": round(gap, 1),
    }
    if gap < 0 or gap > cfg["max_transition_gap_seconds"]:
        return _result(
            "connectivity_unknown",
            confidence=0.2,
            evidence={**common_evidence, "reason": "The event-time gap is too large to determine how the engine stopped."},
            **common,
        )
    if confirmations < cfg["minimum_off_confirmations"]:
        return _result(
            "shutdown_unconfirmed",
            confidence=0.3,
            evidence={**common_evidence, "reason": "A second engine-off observation has not confirmed the transition."},
            **common,
        )

    transition_speed = max(
        _metric(last_running["sample"], "vehicleSpeed") or 0.0,
        _metric(first_off["sample"], "vehicleSpeed") or 0.0,
    )
    if transition_speed > cfg["moving_speed_kph"]:
        return _result(
            "possible_stall_moving",
            confidence=0.95,
            alertable=True,
            evidence={
                **common_evidence,
                "transitionSpeedKph": transition_speed,
                "reason": "Engine speed fell to zero while vehicle speed still indicated movement.",
            },
            **common,
        )

    context_start = first_off["at"] - cfg["context_window_seconds"]
    pre_stop = [
        point for point in points
        if point["state"] == "running"
        and context_start <= point["at"] <= last_running["at"]
        and (_metric(point["sample"], "vehicleSpeed") or 0.0) <= cfg["stopped_speed_kph"]
    ]
    earlier_idle = [
        point for point in points
        if point["state"] == "running"
        and point["at"] < context_start
        and point["rpm"] <= 1500
        and (_metric(point["sample"], "vehicleSpeed") or 0.0) <= cfg["stopped_speed_kph"]
    ][-200:]
    pre_stats = _stats([point["rpm"] for point in pre_stop])
    baseline_stats = _stats([point["rpm"] for point in earlier_idle])
    has_baseline = baseline_stats["count"] >= cfg["minimum_baseline_idle_samples"]
    reference_mean = baseline_stats["mean"] if has_baseline else pre_stats["mean"]
    reference_std = baseline_stats["std"] if has_baseline else 0.0
    low_cutoff = 450.0 if reference_mean is None else max(400.0, reference_mean - max(180.0, reference_std * 4))
    low_dips = sum(1 for point in pre_stop if point["rpm"] < low_cutoff)
    spread = None if not pre_stats["count"] else pre_stats["max"] - pre_stats["min"]
    unstable_variance = (
        pre_stats["count"] >= cfg["minimum_idle_samples"]
        and pre_stats["std"] > max(120.0, reference_std * 3)
    )
    unstable_spread = spread is not None and spread > max(300.0, reference_std * 6)
    rough_idle = (
        pre_stats["count"] >= cfg["minimum_idle_samples"]
        and ((unstable_variance and unstable_spread) or low_dips >= 2)
    )
    evidence = {
        **common_evidence,
        "transitionSpeedKph": transition_speed,
        "preStopSampleCount": pre_stats["count"],
        "preStopRpmMean": pre_stats["mean"],
        "preStopRpmStd": pre_stats["std"],
        "preStopRpmMin": pre_stats["min"],
        "idleBaselineSampleCount": baseline_stats["count"],
        "idleBaselineRpmMean": baseline_stats["mean"],
        "idleBaselineRpmStd": baseline_stats["std"],
        "lowRpmDipCount": low_dips,
    }
    if rough_idle:
        return _result(
            "possible_stall_at_stop",
            confidence=0.82 if has_baseline else 0.72,
            alertable=True,
            evidence={**evidence, "reason": "RPM became unstable at a stop immediately before the engine-off transition."},
            **common,
        )

    clean_idle = (
        pre_stats["count"] >= cfg["minimum_idle_samples"]
        and cfg["running_rpm"] <= pre_stats["mean"] <= 1200
        and pre_stats["std"] <= max(120.0, reference_std * 3)
        and (spread is None or spread <= max(300.0, reference_std * 6))
    )
    if clean_idle and transition_speed <= cfg["stopped_speed_kph"]:
        return _result(
            "intentional_shutdown",
            confidence=0.94 if has_baseline else 0.86,
            evidence={**evidence, "reason": "The vehicle was stopped with stable idle immediately before a confirmed engine-off transition."},
            **common,
        )
    return _result(
        "shutdown_unknown",
        confidence=0.45,
        evidence={**evidence, "reason": "The engine-off transition was confirmed, but the preceding evidence was not decisive."},
        **common,
    )


def select_engine_running_samples(samples: list[dict], **options: Any) -> list[dict]:
    """Retain running buckets and complementary PID buckets adjacent to them."""
    cfg = {**DEFAULTS, **options}
    ordered = _ordered(samples)
    running_times = [
        item["at"] for item in ordered
        if (_metric(item["sample"], "rpm") is not None and _metric(item["sample"], "rpm") >= cfg["running_rpm"])
    ]
    selected = []
    for item in ordered:
        rpm = _metric(item["sample"], "rpm")
        if rpm is not None:
            if rpm >= cfg["running_rpm"]:
                selected.append(item["sample"])
            continue
        position = bisect_left(running_times, item["at"])
        previous = running_times[position - 1] if position > 0 else None
        following = running_times[position] if position < len(running_times) else None
        if (
            previous is not None
            and following is not None
            and item["at"] - previous <= cfg["adjacent_running_window_seconds"]
            and following - item["at"] <= cfg["adjacent_running_window_seconds"]
        ):
            selected.append(item["sample"])
    return selected
