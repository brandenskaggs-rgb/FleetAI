"""Estimate annual savings for Fleet AI predictive maintenance deployment."""

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


def estimate_savings(
    fleet_size: int = 12,
    annual_preventive_maintenance_usd: float = 78_000.0,
    breakdowns_per_truck_per_year: float = 2.3,
    average_breakdown_direct_cost_usd: float = 1_850.0,
    average_downtime_hours_per_breakdown: float = 9.0,
    downtime_cost_per_hour_usd: float = 160.0,
    intervention_success_rate: float = 0.62,
    extra_proactive_maintenance_pct: float = 0.10,
    inspection_cost_per_false_alert_usd: float = 115.0,
) -> dict:
    metrics = load_eval_metrics()
    recall = float(metrics["recall"])
    precision = float(metrics["precision"])

    annual_breakdowns = fleet_size * breakdowns_per_truck_per_year
    prevented_breakdowns = annual_breakdowns * recall * intervention_success_rate

    savings_per_prevented_breakdown = average_breakdown_direct_cost_usd + (
        average_downtime_hours_per_breakdown * downtime_cost_per_hour_usd
    )
    gross_avoided_cost = prevented_breakdowns * savings_per_prevented_breakdown

    predicted_positives = prevented_breakdowns / precision if precision > 0 else prevented_breakdowns
    false_alerts = max(predicted_positives - prevented_breakdowns, 0.0)
    false_alert_cost = false_alerts * inspection_cost_per_false_alert_usd

    additional_proactive_maintenance = (
        annual_preventive_maintenance_usd * extra_proactive_maintenance_pct
    )

    net_annual_savings = (
        gross_avoided_cost - false_alert_cost - additional_proactive_maintenance
    )
    roi_percent = (
        (net_annual_savings / additional_proactive_maintenance) * 100.0
        if additional_proactive_maintenance > 0
        else 0.0
    )

    return {
        "fleet_size": fleet_size,
        "annual_preventive_maintenance_usd": annual_preventive_maintenance_usd,
        "assumptions": {
            "breakdowns_per_truck_per_year": breakdowns_per_truck_per_year,
            "average_breakdown_direct_cost_usd": average_breakdown_direct_cost_usd,
            "average_downtime_hours_per_breakdown": average_downtime_hours_per_breakdown,
            "downtime_cost_per_hour_usd": downtime_cost_per_hour_usd,
            "intervention_success_rate": intervention_success_rate,
            "extra_proactive_maintenance_pct": extra_proactive_maintenance_pct,
            "inspection_cost_per_false_alert_usd": inspection_cost_per_false_alert_usd,
        },
        "model_metrics_used": {"precision": precision, "recall": recall},
        "results": {
            "annual_breakdowns_estimated": round(annual_breakdowns, 2),
            "prevented_breakdowns_estimated": round(prevented_breakdowns, 2),
            "gross_avoided_cost_usd": round(gross_avoided_cost, 2),
            "false_alert_cost_usd": round(false_alert_cost, 2),
            "additional_proactive_maintenance_usd": round(additional_proactive_maintenance, 2),
            "net_annual_savings_usd": round(net_annual_savings, 2),
            "roi_percent": round(roi_percent, 2),
        },
        "notes": (
            "This is a planning model, not proof. Replace assumptions with observed "
            "fleet maintenance events, downtime, and accounting data for production ROI."
        ),
    }


def main() -> None:
    report = estimate_savings()
    out_path = Path(__file__).resolve().parents[1] / "models" / "fleet_ai_savings_report.json"
    out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print("Savings estimate complete")
    print(f"Fleet size: {report['fleet_size']}")
    print(f"Net annual savings (estimate): ${report['results']['net_annual_savings_usd']:,.2f}")
    print(f"Estimated ROI: {report['results']['roi_percent']:.2f}%")
    print(f"Saved report: {out_path}")


if __name__ == "__main__":
    main()
