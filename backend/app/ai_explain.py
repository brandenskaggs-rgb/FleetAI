import os

from dotenv import load_dotenv


load_dotenv()


def explain_alert(alert, learning_mode: bool) -> str:
    if os.getenv("AI_ENABLED", "false").lower() != "true":
        return (
            "Explanation: AI explanations are disabled. This alert is based on "
            "safety thresholds and baseline deviations."
        )

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        return (
            "Explanation: AI unavailable. This alert is based on deterministic thresholds "
            "and baseline deviation scoring."
        )

    mode = "learning" if learning_mode else "optimized"
    return (
        "Explanation: OpenAI integration placeholder enabled. "
        f"Alert context: {alert.title} ({alert.confidence}, {mode} mode)."
    )
