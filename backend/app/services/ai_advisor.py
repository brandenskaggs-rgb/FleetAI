import json
import logging
import os
from typing import Any, Dict, List

from dotenv import load_dotenv
from openai import OpenAI


load_dotenv()
logger = logging.getLogger(__name__)


def _ai_enabled() -> bool:
    return os.getenv("AI_ENABLED", "false").lower() == "true"


def _get_client() -> OpenAI:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set.")
    return OpenAI(api_key=api_key)


def _build_prompt(
    vehicle_id: str,
    telemetry_snapshot: Dict[str, Any],
    telemetry_history: List[Dict[str, Any]],
    learning_mode: bool,
    rules_output: Dict[str, Any],
) -> str:
    history_sample = telemetry_history[:5]
    mode_text = "Learning / Optimization Mode" if learning_mode else "Optimized Mode"
    return (
        "You are an automotive fleet insights assistant.\n"
        "Return a JSON object only with keys: summary, recommended_actions, confidence.\n"
        "Confidence must be one of: low, medium, high.\n"
        f"Vehicle: {vehicle_id}\n"
        f"Mode: {mode_text}\n"
        f"Snapshot: {telemetry_snapshot}\n"
        f"Recent history (latest 5): {history_sample}\n"
        f"Rules output: {rules_output}\n"
        "If in Learning mode, keep confidence language conservative.\n"
    )


def _fallback_response(message: str) -> Dict[str, Any]:
    return {
        "summary": message,
        "recommended_actions": [
            "Retry later after verifying AI configuration.",
            "Review alerts and recent telemetry trends.",
        ],
        "confidence": "low",
    }


def generate_ai_insight(
    vehicle_id: str,
    telemetry_snapshot: Dict[str, Any],
    telemetry_history: List[Dict[str, Any]],
    learning_mode: bool,
    rules_output: Dict[str, Any],
) -> Dict[str, Any]:
    try:
        if not _ai_enabled():
            return _fallback_response(
                "AI insights are disabled. Using deterministic telemetry outputs."
            )
        if not os.getenv("OPENAI_API_KEY"):
            return _fallback_response(
                "AI insight unavailable. Configure OPENAI_API_KEY to enable AI."
            )
        client = _get_client()
        prompt = _build_prompt(
            vehicle_id,
            telemetry_snapshot,
            telemetry_history,
            learning_mode,
            rules_output,
        )
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": "You return JSON only."},
                {"role": "user", "content": prompt},
            ],
            response_format={"type": "json_object"},
            timeout=12,
        )
        content = response.choices[0].message.content or ""
        parsed = json.loads(content)
        return {
            "summary": parsed.get("summary", ""),
            "recommended_actions": parsed.get("recommended_actions", []),
            "confidence": parsed.get("confidence", "low"),
        }
    except Exception as exc:
        logger.exception("AI insight generation failed: %s", exc)
        return _fallback_response(
            "AI insight temporarily unavailable. Using deterministic telemetry outputs."
        )
