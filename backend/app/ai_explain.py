import os
import json

from dotenv import load_dotenv
from openai import OpenAI


load_dotenv()


def _deterministic_explanation(alert, learning_mode: bool) -> str:
    title = getattr(alert, "title", "Vehicle risk alert")
    confidence = getattr(alert, "confidence", "unknown")
    mode = "still calibrating to this vehicle" if learning_mode else "using its calibrated baseline"
    return (
        f"Fleet AI flagged {title.lower()} from measured thresholds and baseline deviation. "
        f"The current confidence is {confidence}, and the model is {mode}. "
        "Review the supporting sensor trend and confirm the condition during normal service; "
        "this is maintenance guidance, not a mechanical diagnosis."
    )


def explain_alert(alert, learning_mode: bool) -> str:
    fallback = _deterministic_explanation(alert, learning_mode)
    if os.getenv("AI_ENABLED", "false").lower() != "true":
        return fallback

    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        return fallback

    alert_data = alert.model_dump(mode="json") if hasattr(alert, "model_dump") else {
        "title": getattr(alert, "title", "Vehicle risk alert"),
        "confidence": getattr(alert, "confidence", "unknown"),
    }
    try:
        response = OpenAI(api_key=api_key).chat.completions.create(
            model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Explain a fleet maintenance alert in plain language. Use only the supplied facts, "
                        "do not diagnose a failed component, do not promise a breakdown, and do not use Markdown."
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps({"alert": alert_data, "learningMode": learning_mode}),
                },
            ],
            max_tokens=180,
            temperature=0.2,
            timeout=12,
        )
        content = (response.choices[0].message.content or "").strip()
        return content[:1200] or fallback
    except Exception:
        return fallback
