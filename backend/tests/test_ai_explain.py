from types import SimpleNamespace

from backend.app.ai_explain import explain_alert


def test_alert_explanation_is_grounded_when_ai_is_disabled(monkeypatch):
    monkeypatch.setenv("AI_ENABLED", "false")
    alert = SimpleNamespace(title="Charging system drift", confidence="medium")

    explanation = explain_alert(alert, learning_mode=True)

    assert "charging system drift" in explanation.lower()
    assert "medium" in explanation.lower()
    assert "calibrating" in explanation.lower()
    assert "placeholder" not in explanation.lower()


def test_alert_explanation_falls_back_without_api_key(monkeypatch):
    monkeypatch.setenv("AI_ENABLED", "true")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    alert = SimpleNamespace(title="Cooling trend", confidence="low")

    explanation = explain_alert(alert, learning_mode=False)

    assert "cooling trend" in explanation.lower()
    assert "calibrated baseline" in explanation.lower()
