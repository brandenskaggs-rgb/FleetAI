# Fleet AI Real-World Training

Use this flow when you want production-grade evidence from real fleet history.

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
python fleet_ai/training/train_real_world.py --csv fleet_ai/training/REAL_DATA_TEMPLATE.csv
```

Optional:

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

To use this model in API/prediction, replace `fleet_ai/models/fleet_ai_model.pkl` with the real-world model file.
