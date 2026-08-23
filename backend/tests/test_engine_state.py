from backend.app.ml.engine_state import classify_engine_event, select_engine_running_samples


def _sample(second: int, rpm: float | None, speed: float = 0.0, battery: float | None = 14.2) -> dict:
    return {
        "ts": f"2026-08-22T12:{second // 60:02d}:{second % 60:02d}.000Z",
        "vehicleId": "VEH_ENGINE",
        "metrics": {
            "rpm": rpm,
            "vehicleSpeed": speed,
            "batteryVoltage": battery,
        },
    }


def test_clean_shutdown_is_not_alertable() -> None:
    samples = [_sample(i * 5, 680 + (i % 3) * 4) for i in range(10)]
    samples += [_sample(50, 0, battery=12.8), _sample(55, 0, battery=None)]
    samples.append(_sample(60, None, battery=12.8))
    event = classify_engine_event(samples)
    assert event["status"] == "intentional_shutdown"
    assert event["alertable"] is False
    assert len(select_engine_running_samples(samples)) == 10


def test_moving_stall_and_service_gap_are_distinct() -> None:
    moving = [_sample(i * 5, 1500, 65) for i in range(8)]
    moving += [_sample(40, 0, 58), _sample(45, 0, 45)]
    event = classify_engine_event(moving)
    assert event["status"] == "possible_stall_moving"
    assert event["alertable"] is True

    gap = [_sample(i * 5, 680) for i in range(8)]
    gap += [_sample(180, 0), _sample(185, 0)]
    event = classify_engine_event(gap)
    assert event["status"] == "connectivity_unknown"
    assert event["alertable"] is False
