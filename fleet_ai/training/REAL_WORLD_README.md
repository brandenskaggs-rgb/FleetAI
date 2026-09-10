# Fleet AI Real-World Training

Use this flow to evaluate labeled fleet history. Exporting a model does not establish production readiness or validated breakdown prediction.

## 1) Prepare CSV

Required columns:

- `timestamp`
- `truck_id`
- `rpm`
- `engine_temp`
- `fuel_pressure`
- `battery_voltage`
- `vibration`
- `ambient_temp_c`
- `elevation_ft`
- `payload_ratio`
- `road_grade_pct`
- `idle_hours_day`
- One label column:
  - `failure` OR
  - `label` OR
  - `failure_within_14d` OR
  - `failure_within_30d`

Use `REAL_DATA_TEMPLATE.csv` as a schema example.

## 2) Train with time-based split

```bash
python fleet_ai/training/train_real_world.py --csv your_labeled_fleet_history.csv
```

Optional:

The template demonstrates the schema only. Both the earlier training period and the later test period must contain failure and non-failure outcomes. Invalid timestamps, missing/fractional labels, and one-class splits are rejected before model export. Null AUC means not assessed, not zero performance. The historical three-row report is not validation evidence.

```bash
python fleet_ai/training/train_real_world.py --csv your_file.csv --test-fraction 0.25
```

## 3) Outputs

- Model bundle:
  - `fleet_ai/models/fleet_ai_model_realworld.pkl`
- Validation report:
  - `fleet_ai/models/fleet_ai_realworld_report.json`

The report contains:

- Balanced metrics
- High-precision profile metrics
- High-recall profile metrics
- ROC-AUC and PR-AUC
- Confusion matrix

## 4) Deploy

Do not automatically replace the active model with an export. Review feature units, sampling intervals, missingness, calibration, independent outcomes, and performance by vehicle class first. Threshold selection currently reuses part of the training period; independent calibration and validation must be addressed before production promotion. Preserve a rollback copy and validate the inference contract in staging.
