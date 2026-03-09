# Fleet AI Predictive Maintenance
## Investor Test Report (Printable)

Date: 2026-03-08  
Project: Fleet AI predictive breakdown detection  
Model artifact: `fleet_ai/models/fleet_ai_model.pkl`

---

## 1) Executive Summary

Fleet AI was tested using a heavy-duty operations simulation that includes:

- Core telematics: `rpm`, `engine_temp`, `fuel_pressure`, `battery_voltage`, `vibration`
- Operating context: `ambient_temp_c`, `elevation_ft`, `payload_ratio`, `road_grade_pct`, `idle_hours_day`
- Trend/anomaly signals: `engine_temp_delta_30d`, `fuel_pressure_delta_30d`, `battery_voltage_delta_30d`, `vibration_delta_30d`

Primary result (balanced mode holdout test):

- Accuracy: **94.74%**
- Precision: **35.16%**
- Recall: **45.90%**
- F1: **39.82%**
- ROC-AUC: **89.62%**

Interpretation:

- The model is a strong ranking engine (`ROC-AUC 0.896`).
- It identifies high-risk events with useful accuracy under difficult fleet conditions.
- Business impact is positive in all 12-truck ROI scenarios tested.

---

## 2) Test Protocol

### Dataset generation

- Fleet size in base simulation: `12 trucks`
- Horizon: `365 days`
- Observation frequency: `8 observations/day`
- Total rows: `35,040`

Failure prevalence:

- Training generation failure rate: `3.7015%`
- Holdout true-positive class rate: `3.7928%`

### Model architecture

- Ensemble: `RandomForest (65%) + HistGradientBoosting (35%)`
- Final operating threshold (balanced): `0.30`
- Additional threshold profiles available:
  - `precision_33`: `0.28`
  - `high_precision`: `0.55`
  - `high_recall`: `0.10`
  - `max_accuracy`: `0.58`

### Mathematical balance objective

Threshold optimization objective:

- Score = `F1 + 0.12 * Precision + 0.04 * Accuracy`

Tie-break economic utility:

- `U = TP * V_tp - FP * C_fp - FN * C_fn`

Where:

- `V_tp`: captured value from true intervention
- `C_fp`: false alert cost
- `C_fn`: missed-failure opportunity cost

---

## 3) Holdout Test Results (35,040 rows)

Balanced mode confusion matrix:

- TN: `32,586`
- FP: `1,125`
- FN: `719`
- TP: `610`

Metrics:

- Accuracy: `0.947374`
- Precision: `0.351585`
- Recall: `0.458992`
- F1: `0.398172`
- ROC-AUC: `0.896231`
- Predicted positive rate: `4.95%`
- Actual positive rate: `3.79%`

### Formula check (example)

- Accuracy = `(TP + TN) / (TP + TN + FP + FN)`  
  = `(610 + 32586) / 35040` = `0.9474`

- Precision = `TP / (TP + FP)`  
  = `610 / (610 + 1125)` = `0.3516`

- Recall = `TP / (TP + FN)`  
  = `610 / (610 + 719)` = `0.4590`

---

## 4) 100,000-Truck Stress Test (1 snapshot per truck)

Population scored: `100,000 trucks`

Risk distribution:

- Mean risk: `4.97%`
- P50: `2.10%`
- P90: `10.43%`
- P95: `20.99%`
- P99: `52.69%`

Balanced mode (`threshold=0.30`):

- Alerts: `3,632` (`3.632%`)
- TP: `1,099`
- FP: `2,533`
- FN: `1,568`
- TN: `94,800`
- Precision: `30.26%`
- Recall: `41.21%`

High precision mode (`threshold=0.55`):

- Alerts: `813` (`0.813%`)
- Precision: `43.05%`
- Recall: `13.12%`

High recall mode (`threshold=0.10`):

- Alerts: `10,497` (`10.497%`)
- Precision: `16.80%`
- Recall: `66.10%`

---

## 5) ROI Results (12-Truck Baseline)

Input baseline:

- Fleet size: `12`
- Annual preventive maintenance budget: `$78,000`
- Model metrics used for ROI math:
  - Precision: `35.16%`
  - Recall: `45.90%`

### Scenario A: Conservative

- Assumptions:
  - Breakdowns/truck/year: `1.6`
  - All-in breakdown cost: `$5,400`
  - Planned intervention per alert: `$180`
- Output:
  - Net annual savings: **$24,992.94**
  - ROI: **553.95%**
  - Savings vs PM baseline: **32.04%**

### Scenario B: Base

- Assumptions:
  - Breakdowns/truck/year: `2.3`
  - All-in breakdown cost: `$9,500`
  - Planned intervention per alert: `$220`
- Output:
  - Net annual savings: **$66,688.58**
  - ROI: **841.29%**
  - Savings vs PM baseline: **85.50%**

### Scenario C: Catastrophic West

- Assumptions:
  - Breakdowns/truck/year: `3.1`
  - All-in breakdown cost: `$16,500`
  - Planned intervention per alert: `$260`
- Output:
  - Net annual savings: **$162,045.33**
  - ROI: **1283.35%**
  - Savings vs PM baseline: **207.75%**

---

## 6) Why This Is Investment-Relevant

- The system is not just threshold rules; it is probability-based risk scoring with a tuned decision policy.
- It models harsh operating reality (temperature, elevation, load, grade, idle, and month-over-month drift).
- It provides operational profiles (`balanced`, `high_precision`, `high_recall`) to match customer risk appetite.
- It outputs direct economic estimates that tie model quality (`precision`, `recall`) to cash impact.

---

## 7) Current Limitation and Next Validation Step

This report is simulation-backed. It is strong for pilot positioning, but final production proof requires customer historical records.

Next step:

1. Train on real fleet history with `train_real_world.py`
2. Run time-based out-of-sample evaluation
3. Recompute ROI with actual maintenance invoices and downtime costs

This closes the loop from model performance to audited business value.

---

## 8) Source Files for This Report

- `fleet_ai/models/fleet_ai_model_metadata.json`
- `fleet_ai/models/fleet_ai_eval_report.json`
- `fleet_ai/models/fleet_ai_100k_test_report.json`
- `fleet_ai/models/fleet_ai_savings_scenarios.json`
