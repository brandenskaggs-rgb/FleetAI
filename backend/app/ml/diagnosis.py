"""
Subsystem and component diagnosis for Fleet AI.

Takes feature data + DTC codes and produces a ranked list of probable causes
with component-level specificity, evidence, and mechanic guidance.

The vehicle is modeled as:
  Brain       → ECU/sensors (read signal noise here)
  Nervous sys → Wiring, grounds, CAN bus
  Heart       → Engine
  Blood/Energy→ Fuel + electrical/charging
  Cooling     → Coolant system (thermostat, water pump, radiator)
  Lungs       → Air intake, turbo, EGR, DPF/emissions
  Skeleton    → Frame/drivetrain/transmission (out of OBD scope, flagged separately)
"""
from __future__ import annotations
import math
from typing import Optional

# ── Subsystem definitions ─────────────────────────────────────────────────────
# Each entry: metrics that indicate stress, DTC prefixes that apply,
# components with their detection logic and guidance.

SUBSYSTEMS = {
    "cooling":     "Cooling System",
    "electrical":  "Electrical / Charging",
    "fuel":        "Fuel System",
    "air_intake":  "Air Intake / Turbo / Boost",
    "emissions":   "Emissions (DPF / EGR / SCR)",
    "sensors":     "Sensor / Signal Noise",
    "engine":      "Engine (Mechanical)",
    "transmission":"Transmission / Drivetrain",
}

# Part cost estimates (USD, rough fleet-grade ranges)
PART_COSTS = {
    "thermostat":        "$25–85",
    "water_pump":        "$200–600",
    "radiator":          "$400–900",
    "head_gasket":       "$1,000–3,000",
    "alternator":        "$300–800",
    "battery":           "$150–400",
    "ground_strap":      "$15–80",
    "injector":          "$150–350 each",
    "fuel_pump":         "$300–700",
    "fuel_filter":       "$30–120",
    "fuel_pressure_reg": "$60–200",
    "turbocharger":      "$1,000–4,000",
    "intercooler":       "$250–800",
    "boost_pipe":        "$50–200",
    "dpf":               "$1,000–3,500",
    "egr_valve":         "$250–600",
    "egr_cooler":        "$400–1,200",
    "scr_catalyst":      "$800–2,500",
    "o2_sensor":         "$50–200",
    "map_sensor":        "$30–120",
    "maf_sensor":        "$80–250",
    "coolant_temp_sensor":"$20–80",
    "timing_chain":      "$800–2,500",
    "piston_rings":      "$500–2,000",
    "transmission_fluid":"$50–200",
    "torque_converter":  "$500–1,500",
}

URGENCY_LEVELS = [
    (0.80, "stop_operating",  "Stop vehicle — imminent failure risk."),
    (0.65, "within_24h",     "Inspect and ground the vehicle within 24 hours."),
    (0.45, "within_7_days",  "Schedule maintenance within 7 days."),
    (0.20, "next_service",   "Address at next scheduled service interval."),
    (0.00, "monitor",        "Monitor — no action required now."),
]


def _urgency(confidence: float) -> tuple[str, str]:
    for threshold, code, note in URGENCY_LEVELS:
        if confidence >= threshold:
            return code, note
    return "monitor", "Monitor — no action required now."


def _safe(val, default=0.0):
    if val is None or (isinstance(val, float) and math.isnan(val)):
        return default
    return float(val)


def _dtc_match(dtc_codes: list[str], prefixes: list[str]) -> list[str]:
    return [c for c in dtc_codes if any(c.upper().startswith(p.upper()) for p in prefixes)]


# ── Component detectors ───────────────────────────────────────────────────────
# Each returns (confidence 0-1, evidence list, mechanic_action, part_key)

def _detect_thermostat(m: dict, dtcs: list[str], slopes: dict) -> tuple:
    evidence = []
    score = 0.0
    coolant = _safe(m.get("coolantTemp"))
    rpm = _safe(m.get("rpm"))
    coolant_slope = _safe(slopes.get("coolantTemp"))
    matched = _dtc_match(dtcs, ["P0128", "P0125"])  # below regulating temp / slow warm-up

    # Heat soak after shutdown commonly raises coolant above 100 C. Do not
    # infer a failed thermostat from temperature alone, especially at 0 RPM.
    if rpm >= 400 and coolant > 110 and coolant_slope > 0.2:
        score += 0.25
        evidence.append(
            f"Coolant reached {coolant:.0f}°C and continued rising while the engine was running."
        )

    if "P0128" in matched:
        score += 0.35; evidence.append("DTC P0128: coolant below thermostat regulating temp — thermostat likely stuck open.")
    if "P0125" in matched:
        score += 0.25; evidence.append("DTC P0125: slow warm-up — thermostat not closing properly.")

    return score, evidence, "Inspect and replace thermostat. Check coolant level and hose integrity.", "thermostat"


def _detect_water_pump(m: dict, dtcs: list[str], slopes: dict) -> tuple:
    evidence = []
    score = 0.0
    coolant = _safe(m.get("coolantTemp"))
    rpm = _safe(m.get("rpm"))
    coolant_slope = _safe(slopes.get("coolantTemp"))
    matched = _dtc_match(dtcs, ["P0217"])

    if rpm >= 400 and coolant > 118 and coolant_slope > 0.5:
        score += 0.35
        evidence.append(
            f"Coolant reached {coolant:.0f}°C with a sustained rise while the engine was running."
        )

    for dtc in matched:
        score += 0.20; evidence.append(f"DTC {dtc}: engine overtemp code consistent with pump failure.")

    return score, evidence, "Inspect water pump for leaks, worn impeller, or bearing failure. Check coolant flow at idle.", "water_pump"


def _detect_alternator(m: dict, dtcs: list[str], slopes: dict) -> tuple:
    evidence = []
    score = 0.0
    voltage = _safe(m.get("batteryVoltage"), 14.0)
    rpm = _safe(m.get("rpm"))
    v_slope = _safe(slopes.get("batteryVoltage"))
    matched = _dtc_match(dtcs, ["P0620", "P0621", "P0622", "P0625", "P0626"])

    if voltage < 13.0 and rpm > 600:
        score += 0.45; evidence.append(f"Battery voltage {voltage:.1f}V at {rpm:.0f} RPM — alternator undercharging.")
    elif voltage < 13.5 and rpm > 800:
        score += 0.25; evidence.append(f"Low charge voltage {voltage:.1f}V while engine running.")

    if v_slope < -0.02:
        score += 0.20; evidence.append("Voltage trending downward — alternator output deteriorating.")

    for dtc in matched:
        score += 0.25; evidence.append(f"DTC {dtc}: alternator/generator control circuit fault.")

    return score, evidence, "Test alternator output at idle and load. Check belt tension and regulator. Measure output ripple.", "alternator"


def _detect_battery(m: dict, dtcs: list[str], slopes: dict) -> tuple:
    evidence = []
    score = 0.0
    voltage = _safe(m.get("batteryVoltage"), 14.0)
    rpm = _safe(m.get("rpm"))
    matched = _dtc_match(dtcs, ["P0560", "P0561", "P0562", "P0563"])

    if voltage < 12.0 and rpm < 200:
        score += 0.50; evidence.append(f"Battery resting voltage {voltage:.1f}V — below serviceable threshold (<12.4V).")
    elif voltage < 12.4 and rpm < 200:
        score += 0.30; evidence.append(f"Battery resting voltage {voltage:.1f}V — weak, consider load test.")

    if _safe(m.get("engineLoad")) > 80 and voltage < 13.0:
        score += 0.20; evidence.append("High load with low voltage — battery may not be holding charge under demand.")

    for dtc in matched:
        score += 0.20; evidence.append(f"DTC {dtc}: system voltage anomaly detected.")

    return score, evidence, "Load-test battery. Check terminals for corrosion. Inspect ground straps for continuity.", "battery"


def _detect_ground_fault(m: dict, dtcs: list[str], slopes: dict) -> tuple:
    """Ground/wiring faults show up as multi-sensor noise with no single component culprit."""
    evidence = []
    score = 0.0
    voltage = _safe(m.get("batteryVoltage"), 14.0)

    # Multiple erratic sensor codes with no clear subsystem = ground suspect
    sensor_dtcs = _dtc_match(dtcs, ["P0100", "P0105", "P0110", "P0115", "P0120", "P0130", "P0335", "U0"])
    if len(sensor_dtcs) >= 3:
        score += 0.40; evidence.append(f"{len(sensor_dtcs)} sensor fault codes with no single subsystem — possible ground or CAN bus issue.")

    if voltage < 11.8:
        score += 0.20; evidence.append(f"Low system voltage {voltage:.1f}V can induce false sensor codes.")

    if any(c.startswith("U0") for c in dtcs):
        score += 0.35; evidence.append("CAN bus communication fault detected — inspect wiring harness and grounds.")

    return score, evidence, "Inspect main ground straps (battery to chassis, engine to chassis). Check for corrosion, loose connections, and damaged harness.", "ground_strap"


def _detect_fuel_injectors(m: dict, dtcs: list[str], slopes: dict) -> tuple:
    evidence = []
    score = 0.0
    fuel_rate = _safe(m.get("fuelRate"))
    engine_load = _safe(m.get("engineLoad"))
    maf = _safe(m.get("maf"))
    matched = _dtc_match(dtcs, ["P0201", "P0202", "P0203", "P0204", "P0205", "P0206", "P030"])

    if fuel_rate > 0 and engine_load > 0 and maf > 0:
        # High fuel rate relative to load suggests injector inefficiency
        ratio = fuel_rate / max(engine_load * 0.01 * (maf + 1), 1)
        if ratio > 2.5:
            score += 0.30; evidence.append(f"Fuel rate high relative to engine load — injector efficiency suspect.")

    misfires = _dtc_match(dtcs, ["P0300", "P0301", "P0302", "P0303", "P0304", "P0305", "P0306"])
    if misfires:
        score += 0.25; evidence.append(f"Misfire codes {', '.join(misfires[:3])} — injector spray pattern or timing suspect.")

    for dtc in matched:
        score += 0.30; evidence.append(f"DTC {dtc}: injector circuit fault.")

    return score, evidence, "Perform injector balance test. Check fuel trim values. Inspect for leaking or clogged injectors.", "injector"


def _detect_fuel_pump(m: dict, dtcs: list[str], slopes: dict) -> tuple:
    evidence = []
    score = 0.0
    matched = _dtc_match(dtcs, ["P0087", "P0088", "P0089", "P0191", "P0192", "P0193"])

    if "P0087" in dtcs:
        score += 0.55; evidence.append("DTC P0087: fuel rail pressure too low — fuel pump or pressure regulator failing.")
    if "P0088" in dtcs:
        score += 0.40; evidence.append("DTC P0088: fuel rail pressure too high — stuck regulator or return line blockage.")

    for dtc in [d for d in matched if d not in ("P0087", "P0088")]:
        score += 0.20; evidence.append(f"DTC {dtc}: fuel pressure circuit fault.")

    fuel_level = _safe(m.get("fuelLevel"))
    if fuel_level < 10 and score > 0:
        evidence.append(f"Fuel level low at {fuel_level:.0f}% — confirm adequate fuel before diagnosing pump.")

    return score, evidence, "Check fuel pressure at rail. Test pump output volume. Inspect fuel filter — a clogged filter mimics pump failure.", "fuel_pump"


def _detect_turbo(m: dict, dtcs: list[str], slopes: dict) -> tuple:
    evidence = []
    score = 0.0
    map_pressure = _safe(m.get("intakeManifoldPressure"))
    engine_load = _safe(m.get("engineLoad"))
    rpm = _safe(m.get("rpm"))
    matched_over = _dtc_match(dtcs, ["P0234", "P0235", "P0236"])
    matched_under = _dtc_match(dtcs, ["P0299", "P0296"])

    if map_pressure > 230 and rpm > 1500:
        score += 0.40; evidence.append(f"Intake manifold pressure {map_pressure:.0f} kPa — overboost territory.")
        for dtc in matched_over:
            score += 0.20; evidence.append(f"DTC {dtc}: turbo overboost confirmed.")
    elif engine_load > 75 and map_pressure < 130 and rpm > 1800:
        score += 0.35; evidence.append(f"High load ({engine_load:.0f}%) with low MAP ({map_pressure:.0f} kPa) — underboost/turbo lag.")
        for dtc in matched_under:
            score += 0.25; evidence.append(f"DTC {dtc}: insufficient boost pressure confirmed.")

    return score, evidence, "Inspect turbo wastegate, actuator, and boost pipes for leaks. Check intercooler for oil contamination. Inspect compressor wheel.", "turbocharger"


def _detect_dpf(m: dict, dtcs: list[str], slopes: dict) -> tuple:
    evidence = []
    score = 0.0
    dpf_load = _safe(m.get("dpfSootLoad"))
    matched = _dtc_match(dtcs, ["P2002", "P2003", "P2452", "P2453", "P2454", "P2455"])

    if dpf_load > 90:
        score += 0.60; evidence.append(f"DPF soot load {dpf_load:.0f}% — critical, regen blocked or failing.")
    elif dpf_load > 80:
        score += 0.35; evidence.append(f"DPF soot load {dpf_load:.0f}% — high, active regen may be needed.")
    elif dpf_load > 70:
        score += 0.15; evidence.append(f"DPF soot load {dpf_load:.0f}% — approaching regen threshold.")

    for dtc in matched:
        score += 0.20; evidence.append(f"DTC {dtc}: DPF system fault detected.")

    return score, evidence, "Force a parked DPF regeneration. If unsuccessful, inspect DPF for ash overload or physical damage. Check EGR and fuel injectors for excessive soot generation.", "dpf"


def _detect_egr(m: dict, dtcs: list[str], slopes: dict) -> tuple:
    evidence = []
    score = 0.0
    matched = _dtc_match(dtcs, ["P0400", "P0401", "P0402", "P0403", "P0404", "P0405", "P0406"])

    for dtc in matched:
        score += 0.25; evidence.append(f"DTC {dtc}: EGR flow/position fault.")

    if len(matched) >= 2:
        score += 0.20; evidence.append("Multiple EGR codes — valve likely stuck or cooler blocked.")

    return score, evidence, "Inspect EGR valve for carbon buildup. Test EGR valve operation and duty cycle. Check EGR cooler for coolant contamination.", "egr_valve"


def _detect_o2_sensor(m: dict, dtcs: list[str], slopes: dict) -> tuple:
    evidence = []
    score = 0.0
    matched = _dtc_match(dtcs, ["P0131", "P0132", "P0133", "P0134", "P0135",
                                  "P0136", "P0137", "P0138", "P0141", "P0171", "P0172"])

    for dtc in matched[:3]:
        score += 0.25; evidence.append(f"DTC {dtc}: O2 sensor signal fault.")

    if matched:
        # Check if fuel metrics corroborate — if not, likely just the sensor
        fuel_rate = m.get("fuelRate")
        maf = m.get("maf")
        if fuel_rate is None and maf is None:
            evidence.append("No corroborating fuel metrics — likely a sensor failure, not a fuel system issue.")
            score = min(score, 0.50)  # cap at 50% if uncorroborated

    return score, evidence, "Replace suspected O2 sensor. Check wiring connector for corrosion. Verify there are no exhaust leaks upstream of sensor.", "o2_sensor"


def _detect_map_maf_sensor(m: dict, dtcs: list[str], slopes: dict) -> tuple:
    evidence = []
    score = 0.0
    map_dtcs = _dtc_match(dtcs, ["P0105", "P0106", "P0107", "P0108"])
    maf_dtcs = _dtc_match(dtcs, ["P0100", "P0101", "P0102", "P0103"])

    for dtc in map_dtcs:
        score += 0.30; evidence.append(f"DTC {dtc}: MAP sensor circuit fault.")
    for dtc in maf_dtcs:
        score += 0.30; evidence.append(f"DTC {dtc}: MAF sensor circuit fault.")

    if score > 0:
        evidence.append("Sensor faults often caused by connector corrosion, vacuum leaks, or sensor contamination.")

    part = "map_sensor" if map_dtcs else "maf_sensor"
    return score, evidence, "Clean or replace MAP/MAF sensor. Inspect intake for air leaks. Check wiring harness for damage or moisture ingress.", part


def _detect_timing(m: dict, dtcs: list[str], slopes: dict) -> tuple:
    evidence = []
    score = 0.0
    matched = _dtc_match(dtcs, ["P0016", "P0017", "P0018", "P0019", "P0020", "P0021"])

    for dtc in matched:
        score += 0.40; evidence.append(f"DTC {dtc}: cam/crank correlation fault — timing chain stretch or VVT failure.")

    rpm = _safe(m.get("rpm"))
    engine_load = _safe(m.get("engineLoad"))
    if matched and rpm < 1000 and engine_load > 50:
        score += 0.20; evidence.append("Timing issue under load — chain tensioner or VVT solenoid likely involved.")

    return score, evidence, "Check timing chain tension and VVT solenoid operation. Verify oil pressure — low oil causes timing chain skip. Do NOT run engine if code is active.", "timing_chain"


# ── Detection registry ────────────────────────────────────────────────────────

_DETECTORS = [
    # (subsystem,      component_name,     detector_fn,                 part_key)
    ("cooling",        "Thermostat",        _detect_thermostat,          "thermostat"),
    ("cooling",        "Water Pump",        _detect_water_pump,          "water_pump"),
    ("electrical",     "Alternator",        _detect_alternator,          "alternator"),
    ("electrical",     "Battery",           _detect_battery,             "battery"),
    ("electrical",     "Ground / Wiring",   _detect_ground_fault,        "ground_strap"),
    ("fuel",           "Fuel Injector(s)",  _detect_fuel_injectors,      "injector"),
    ("fuel",           "Fuel Pump",         _detect_fuel_pump,           "fuel_pump"),
    ("air_intake",     "Turbocharger",      _detect_turbo,               "turbocharger"),
    ("emissions",      "DPF Filter",        _detect_dpf,                 "dpf"),
    ("emissions",      "EGR Valve",         _detect_egr,                 "egr_valve"),
    ("sensors",        "O2 Sensor",         _detect_o2_sensor,           "o2_sensor"),
    ("sensors",        "MAP / MAF Sensor",  _detect_map_maf_sensor,      "map_sensor"),
    ("engine",         "Timing Chain / VVT",_detect_timing,              "timing_chain"),
]


def _extract_slopes(window_stats: Optional[dict]) -> dict:
    """Pull 24h slope per metric from window_stats for trend detection."""
    if not window_stats:
        return {}
    slopes = {}
    for metric, stats in window_stats.items():
        h24 = stats.get("h24", {})
        slope = h24.get("slope")
        if slope is not None:
            slopes[metric] = slope
    return slopes


def run_diagnosis(
    current_metrics: dict,
    dtc_codes: list[str],
    window_stats: Optional[dict] = None,
    multivariate_stress: Optional[dict] = None,
) -> dict:
    """
    Run all component detectors and return structured diagnosis.

    Returns:
      {
        "primaryDiagnosis": {...} | None,
        "secondaryFindings": [...],
        "subsystemSummary": {subsystem: {risk, status, label}},
        "sensorNoise": {detected: bool, suspects: [...], note: str},
        "noFaultDetected": bool,
      }
    """
    m = current_metrics or {}
    dtcs = [str(c).strip().upper() for c in (dtc_codes or []) if c]
    slopes = _extract_slopes(window_stats)

    # Run all detectors
    findings = []
    for subsystem, component, fn, part_key in _DETECTORS:
        try:
            confidence, evidence, action, _ = fn(m, dtcs, slopes)
        except Exception:
            continue
        if confidence < 0.05 or not evidence:
            continue
        urgency_code, urgency_note = _urgency(confidence)
        findings.append({
            "subsystem": subsystem,
            "subsystemLabel": SUBSYSTEMS.get(subsystem, subsystem),
            "component": component,
            "confidence": round(min(1.0, confidence), 3),
            "urgency": urgency_code,
            "urgencyNote": urgency_note,
            "evidence": evidence,
            "mechanicAction": action,
            "estimatedPartCost": PART_COSTS.get(part_key),
        })

    # Sort by confidence descending
    findings.sort(key=lambda x: x["confidence"], reverse=True)

    # Build subsystem risk summary
    subsystem_risk: dict[str, float] = {}
    for f in findings:
        ss = f["subsystem"]
        subsystem_risk[ss] = max(subsystem_risk.get(ss, 0.0), f["confidence"])

    # Add multivariate stress if present
    if multivariate_stress:
        for ss_key, stress_val in multivariate_stress.items():
            subsystem_risk[ss_key] = max(subsystem_risk.get(ss_key, 0.0), float(stress_val))

    def _status(risk):
        if risk >= 0.65: return "critical"
        if risk >= 0.40: return "degraded"
        if risk >= 0.15: return "elevated"
        return "normal"

    subsystem_summary = {
        ss: {
            "risk": round(subsystem_risk.get(ss, 0.0), 3),
            "status": _status(subsystem_risk.get(ss, 0.0)),
            "label": SUBSYSTEMS.get(ss, ss),
        }
        for ss in SUBSYSTEMS
    }

    # Identify sensor noise (sensor findings without corroborating mechanical evidence)
    sensor_findings = [f for f in findings if f["subsystem"] == "sensors"]
    mechanical_confidence = max(
        (f["confidence"] for f in findings if f["subsystem"] not in ("sensors",)),
        default=0.0
    )
    sensor_noise_detected = bool(sensor_findings) and mechanical_confidence < 0.25

    sensor_noise = {
        "detected": sensor_noise_detected,
        "suspects": [f["component"] for f in sensor_findings],
        "note": (
            "Sensor fault codes present but no corroborating mechanical anomalies. "
            "Likely a bad sensor rather than a real system fault. Replace sensor before further diagnosis."
            if sensor_noise_detected else
            "Sensor readings appear consistent with mechanical findings."
        )
    }

    return {
        "primaryDiagnosis": findings[0] if findings else None,
        "secondaryFindings": findings[1:5],  # up to 4 additional findings
        "subsystemSummary": subsystem_summary,
        "sensorNoise": sensor_noise,
        "noFaultDetected": len(findings) == 0,
        "totalFindingsCount": len(findings),
    }
