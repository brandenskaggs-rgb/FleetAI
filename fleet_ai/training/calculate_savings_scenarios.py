"""Simple, defensible ROI scenarios tied to model precision/recall."""

from __future__ import annotations

import json
from pathlib import Path


def load_eval_metrics() -> dict:
    report_path = Path(__file__).resolve().parents[1] / "models" / "fleet_ai_eval_report.json"
    if not report_path.exists():
        raise FileNotFoundError(
            f"Missing eval report at {report_path}. Run training/evaluate_model.py first."
        )
    return json.loads(report_path.read_text(encoding="utf-8"))


def scenario_roi(
    precision: float,
    recall: float,
    fleet_size: int,
    annual_preventive_maintenance_usd: float,
    breakdowns_per_truck_per_year: float,
    breakdown_total_cost_usd: float,
    planned_intervention_cost_per_alert_usd: float,
    intervention_success_rate: float = 0.62,
) -> dict:
    """Compute ROI from model metrics + scenario assumptions."""
    annual_breakdowns = fleet_size * breakdowns_per_truck_per_year

    # True positives from model behavior.
    detected_breakdowns = annual_breakdowns * recall
    prevented_breakdowns = detected_breakdowns * intervention_success_rate

    # Alerts implied by precision.
    predicted_alerts = detected_breakdowns / precision if precision > 0 else detected_breakdowns
    false_alerts = max(predicted_alerts - detected_breakdowns, 0.0)

    gross_avoided_cost = prevented_breakdowns * breakdown_total_cost_usd
    proactive_cost = predicted_alerts * planned_intervention_cost_per_alert_usd
    net_annual_savings = gross_avoided_cost - proactive_cost

    roi_percent = (net_annual_savings / proactive_cost) * 100.0 if proactive_cost > 0 else 0.0
    savings_vs_pm_percent = (
        (net_annual_savings / annual_preventive_maintenance_usd) * 100.0
        if annual_preventive_maintenance_usd > 0
        else 0.0
    )

    return {
        "annual_breakdowns_est": round(annual_breakdowns, 2),
        "detected_breakdowns_est": round(detected_breakdowns, 2),
        "prevented_breakdowns_est": round(prevented_breakdowns, 2),
        "predicted_alerts_est": round(predicted_alerts, 2),
        "false_alerts_est": round(false_alerts, 2),
        "gross_avoided_cost_usd": round(gross_avoided_cost, 2),
        "proactive_intervention_cost_usd": round(proactive_cost, 2),
        "net_annual_savings_usd": round(net_annual_savings, 2),
        "roi_percent": round(roi_percent, 2),
        "savings_vs_pm_percent": round(savings_vs_pm_percent, 2),
    }


def build_report() -> dict:
    metrics = load_eval_metrics()
    precision = float(metrics["precision"])
    recall = float(metrics["recall"])

    fleet_size = 12
    annual_pm = 78_000.0

    scenarios = {
        # Lower event frequency and lower all-in breakdown cost.
        "conservative": {
            "breakdowns_per_truck_per_year": 1.6,
            "breakdown_total_cost_usd": 5_400.0,
            "planned_intervention_cost_per_alert_usd": 180.0,
        },
        # Practical middle for mixed operation lanes.
        "base": {
            "breakdowns_per_truck_per_year": 2.3,
            "breakdown_total_cost_usd": 9_500.0,
            "planned_intervention_cost_per_alert_usd": 220.0,
        },
        # Catastrophic-distance / hard-lane operations.
        "catastrophic_west": {
            "breakdowns_per_truck_per_year": 3.1,
            "breakdown_total_cost_usd": 16_500.0,
            "planned_intervention_cost_per_alert_usd": 260.0,
        },
    }

    out = {
        "fleet_size": fleet_size,
        "annual_preventive_maintenance_usd": annual_pm,
        "model_metrics_used": {"precision": precision, "recall": recall},
        "scenarios": {},
        "notes": (
            "Scenario economics use all-in breakdown cost assumptions (repair+tow+downtime impact). "
            "Replace with your real accounting values per customer for final proposal."
        ),
    }

    for name, config in scenarios.items():
        out["scenarios"][name] = {
            "assumptions": config,
            "results": scenario_roi(
                precision=precision,
                recall=recall,
                fleet_size=fleet_size,
                annual_preventive_maintenance_usd=annual_pm,
                breakdowns_per_truck_per_year=config["breakdowns_per_truck_per_year"],
                breakdown_total_cost_usd=config["breakdown_total_cost_usd"],
                planned_intervention_cost_per_alert_usd=config[
                    "planned_intervention_cost_per_alert_usd"
                ],
            ),
        }
    return out


def main() -> None:
    report = build_report()
    out_path = Path(__file__).resolve().parents[1] / "models" / "fleet_ai_savings_scenarios.json"
    out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print("Scenario ROI complete")
    for name, block in report["scenarios"].items():
        result = block["results"]
        print(
            f"{name}: net=${result['net_annual_savings_usd']:,.2f} | "
            f"ROI={result['roi_percent']:.2f}% | "
            f"savings_vs_pm={result['savings_vs_pm_percent']:.2f}%"
        )
    print(f"Saved report: {out_path}")


if __name__ == "__main__":
    main()
