"""
DTC Fault Tree Knowledge Base — OBD-II / SAE J1939 / J1708
Covers the most common diagnostic trouble codes for commercial fleet vehicles.

Each entry maps a DTC code to:
  system         — which vehicle subsystem is affected
  component      — specific component
  description    — human-readable fault description
  severity       — "info" | "warning" | "critical"
  failure_risk   — 0.0-1.0 probability of imminent failure if unaddressed
  related_dtcs   — codes that frequently appear together (co-occurrence)
  co_risk_boost  — multiplier applied to fleet risk when related codes also present
  actions        — ordered recommended actions
"""
from typing import Optional

DTC_KB: dict[str, dict] = {
    # ── COOLING SYSTEM ────────────────────────────────────────────────────────
    "P0115": {"system":"cooling","component":"coolant_temp_sensor","description":"Engine Coolant Temp Sensor 1 Circuit","severity":"warning","failure_risk":0.40,"related_dtcs":["P0116","P0217","P0128"],"co_risk_boost":1.3,"actions":["Inspect coolant temp sensor wiring","Replace coolant temp sensor if reading erratic","Check for coolant leaks"]},
    "P0116": {"system":"cooling","component":"coolant_temp_sensor","description":"Engine Coolant Temp Sensor 1 Range/Performance","severity":"warning","failure_risk":0.45,"related_dtcs":["P0115","P0217"],"co_risk_boost":1.3,"actions":["Test coolant temp sensor output","Inspect thermostat","Check for air pockets in cooling system"]},
    "P0117": {"system":"cooling","component":"coolant_temp_sensor","description":"Engine Coolant Temp Sensor 1 Low Voltage","severity":"warning","failure_risk":0.35,"related_dtcs":["P0118"],"co_risk_boost":1.1,"actions":["Check sensor connector for corrosion","Test circuit continuity"]},
    "P0118": {"system":"cooling","component":"coolant_temp_sensor","description":"Engine Coolant Temp Sensor 1 High Voltage","severity":"warning","failure_risk":0.35,"related_dtcs":["P0117"],"co_risk_boost":1.1,"actions":["Check for open circuit in sensor wiring","Inspect sensor ground"]},
    "P0125": {"system":"cooling","component":"thermostat","description":"Insufficient Coolant Temp for Closed Loop Fuel Control","severity":"warning","failure_risk":0.50,"related_dtcs":["P0128","P0116"],"co_risk_boost":1.2,"actions":["Replace thermostat","Inspect coolant flow","Check for stuck-open thermostat"]},
    "P0128": {"system":"cooling","component":"thermostat","description":"Coolant Temp Below Thermostat Regulating Temperature","severity":"warning","failure_risk":0.55,"related_dtcs":["P0125","P0217"],"co_risk_boost":1.3,"actions":["Replace thermostat immediately","Inspect cooling system for leaks","Check coolant level"]},
    "P0217": {"system":"cooling","component":"engine","description":"Engine Over-Temperature Condition","severity":"critical","failure_risk":0.90,"related_dtcs":["P0128","P0115","P0218","P0116"],"co_risk_boost":1.5,"actions":["Pull over immediately if temperature spike is active","Inspect coolant level","Check radiator and hoses","Test water pump","Inspect head gasket"]},
    "P0218": {"system":"cooling","component":"transmission","description":"Transmission Over-Temperature","severity":"critical","failure_risk":0.80,"related_dtcs":["P0217","P0700"],"co_risk_boost":1.4,"actions":["Check transmission fluid level and condition","Inspect trans cooler lines","Allow transmission to cool before resuming"]},
    "P0219": {"system":"engine","component":"engine_speed","description":"Engine Overspeed Condition","severity":"critical","failure_risk":0.75,"related_dtcs":["P0300"],"co_risk_boost":1.3,"actions":["Inspect governor/throttle control","Check for stuck throttle","Review driver behavior logs"]},

    # ── FUEL SYSTEM ──────────────────────────────────────────────────────────
    "P0087": {"system":"fuel","component":"fuel_rail","description":"Fuel Rail Pressure Too Low","severity":"critical","failure_risk":0.80,"related_dtcs":["P0088","P0090","P0251"],"co_risk_boost":1.4,"actions":["Check fuel filter — replace if due","Inspect fuel pump","Test fuel pressure regulator","Check for fuel line restrictions"]},
    "P0088": {"system":"fuel","component":"fuel_rail","description":"Fuel Rail Pressure Too High","severity":"critical","failure_risk":0.75,"related_dtcs":["P0087","P0090"],"co_risk_boost":1.4,"actions":["Test fuel pressure regulator","Inspect injector return lines","Check for blocked fuel return"]},
    "P0089": {"system":"fuel","component":"fuel_pressure_regulator","description":"Fuel Pressure Regulator 1 Performance","severity":"warning","failure_risk":0.60,"related_dtcs":["P0087","P0088"],"co_risk_boost":1.3,"actions":["Replace fuel pressure regulator","Inspect fuel pump output"]},
    "P0090": {"system":"fuel","component":"fuel_pressure_regulator","description":"Fuel Pressure Regulator 1 Control Circuit","severity":"warning","failure_risk":0.55,"related_dtcs":["P0087","P0089"],"co_risk_boost":1.2,"actions":["Inspect FPR wiring and connector","Test regulator solenoid resistance"]},
    "P0251": {"system":"fuel","component":"injection_pump","description":"Injection Pump Fuel Metering Control A Malfunction","severity":"critical","failure_risk":0.85,"related_dtcs":["P0087","P0252"],"co_risk_boost":1.5,"actions":["Inspect injection pump","Check fuel supply to pump","Test pump timing"]},
    "P0191": {"system":"fuel","component":"fuel_rail_pressure_sensor","description":"Fuel Rail Pressure Sensor Range/Performance","severity":"warning","failure_risk":0.50,"related_dtcs":["P0087","P0192","P0193"],"co_risk_boost":1.2,"actions":["Replace fuel rail pressure sensor","Check sensor wiring"]},

    # ── MISFIRES / IGNITION ──────────────────────────────────────────────────
    "P0300": {"system":"ignition","component":"multiple_cylinders","description":"Random/Multiple Cylinder Misfire Detected","severity":"critical","failure_risk":0.85,"related_dtcs":["P0301","P0302","P0303","P0304","P0171","P0174","P0087"],"co_risk_boost":1.5,"actions":["Check spark plugs and wires","Inspect ignition coils","Test fuel injectors","Check compression"]},
    "P0301": {"system":"ignition","component":"cylinder_1","description":"Cylinder 1 Misfire","severity":"warning","failure_risk":0.65,"related_dtcs":["P0300","P0302"],"co_risk_boost":1.2,"actions":["Check spark plug cylinder 1","Inspect injector cylinder 1","Test compression cylinder 1"]},
    "P0302": {"system":"ignition","component":"cylinder_2","description":"Cylinder 2 Misfire","severity":"warning","failure_risk":0.65,"related_dtcs":["P0300","P0301"],"co_risk_boost":1.2,"actions":["Check spark plug cylinder 2","Inspect injector cylinder 2"]},
    "P0303": {"system":"ignition","component":"cylinder_3","description":"Cylinder 3 Misfire","severity":"warning","failure_risk":0.65,"related_dtcs":["P0300"],"co_risk_boost":1.2,"actions":["Check spark plug cylinder 3","Inspect injector cylinder 3"]},
    "P0304": {"system":"ignition","component":"cylinder_4","description":"Cylinder 4 Misfire","severity":"warning","failure_risk":0.65,"related_dtcs":["P0300"],"co_risk_boost":1.2,"actions":["Check spark plug cylinder 4"]},

    # ── AIR / FUEL METERING ──────────────────────────────────────────────────
    "P0100": {"system":"fuel","component":"maf_sensor","description":"Mass Air Flow Sensor Circuit Malfunction","severity":"warning","failure_risk":0.55,"related_dtcs":["P0101","P0102","P0103"],"co_risk_boost":1.2,"actions":["Inspect MAF sensor and wiring","Clean MAF sensor with proper cleaner","Replace if cleaning fails"]},
    "P0101": {"system":"fuel","component":"maf_sensor","description":"MAF Sensor Range/Performance Problem","severity":"warning","failure_risk":0.50,"related_dtcs":["P0100","P0171","P0174"],"co_risk_boost":1.2,"actions":["Clean MAF sensor","Check for vacuum leaks","Inspect air filter"]},
    "P0171": {"system":"fuel","component":"fuel_trim","description":"System Too Lean (Bank 1)","severity":"warning","failure_risk":0.55,"related_dtcs":["P0174","P0101","P0087","P0300"],"co_risk_boost":1.3,"actions":["Check for vacuum leaks","Inspect fuel pressure","Clean or replace MAF sensor","Check fuel injectors"]},
    "P0174": {"system":"fuel","component":"fuel_trim","description":"System Too Lean (Bank 2)","severity":"warning","failure_risk":0.55,"related_dtcs":["P0171","P0101","P0087"],"co_risk_boost":1.3,"actions":["Check for vacuum leaks","Inspect fuel pressure"]},
    "P0172": {"system":"fuel","component":"fuel_trim","description":"System Too Rich (Bank 1)","severity":"warning","failure_risk":0.50,"related_dtcs":["P0175","P0172","P0088"],"co_risk_boost":1.2,"actions":["Check for fuel leaks into intake","Inspect O2 sensor","Test fuel pressure regulator"]},

    # ── O2 SENSORS ──────────────────────────────────────────────────────────
    "P0131": {"system":"emissions","component":"o2_sensor_b1s1","description":"O2 Sensor Low Voltage (Bank 1 Sensor 1)","severity":"warning","failure_risk":0.45,"related_dtcs":["P0132","P0171"],"co_risk_boost":1.1,"actions":["Replace O2 sensor Bank 1 Sensor 1","Check for exhaust leaks near sensor"]},
    "P0420": {"system":"emissions","component":"catalytic_converter","description":"Catalyst System Efficiency Below Threshold (Bank 1)","severity":"warning","failure_risk":0.60,"related_dtcs":["P0430","P0300","P0131"],"co_risk_boost":1.3,"actions":["Inspect catalytic converter","Check for misfires feeding bad exhaust to cat","Verify O2 sensor function"]},
    "P0430": {"system":"emissions","component":"catalytic_converter","description":"Catalyst System Efficiency Below Threshold (Bank 2)","severity":"warning","failure_risk":0.60,"related_dtcs":["P0420"],"co_risk_boost":1.2,"actions":["Inspect catalytic converter Bank 2","Verify upstream O2 sensor function"]},

    # ── EGR SYSTEM ──────────────────────────────────────────────────────────
    "P0400": {"system":"emissions","component":"egr","description":"Exhaust Gas Recirculation Flow Malfunction","severity":"warning","failure_risk":0.50,"related_dtcs":["P0401","P0402","P0403"],"co_risk_boost":1.2,"actions":["Inspect EGR valve — clean or replace","Check EGR passages for carbon buildup","Test EGR valve solenoid"]},
    "P0401": {"system":"emissions","component":"egr","description":"Exhaust Gas Recirculation Insufficient Flow","severity":"warning","failure_risk":0.55,"related_dtcs":["P0400","P0403"],"co_risk_boost":1.2,"actions":["Clean EGR passages","Inspect EGR cooler","Replace EGR valve if stuck closed"]},
    "P0402": {"system":"emissions","component":"egr","description":"Exhaust Gas Recirculation Excessive Flow","severity":"warning","failure_risk":0.50,"related_dtcs":["P0400"],"co_risk_boost":1.1,"actions":["Inspect EGR valve for stuck-open condition","Clean or replace EGR valve"]},
    "P0403": {"system":"emissions","component":"egr_solenoid","description":"EGR Solenoid Circuit Malfunction","severity":"warning","failure_risk":0.45,"related_dtcs":["P0400","P0401"],"co_risk_boost":1.1,"actions":["Test EGR solenoid resistance","Inspect wiring to EGR solenoid"]},

    # ── DPF / AFTERTREATMENT ─────────────────────────────────────────────────
    "P2002": {"system":"aftertreatment","component":"dpf","description":"DPF Efficiency Below Threshold (Bank 1)","severity":"critical","failure_risk":0.80,"related_dtcs":["P2003","P2459","P242F"],"co_risk_boost":1.5,"actions":["Initiate forced DPF regen if safe","Inspect DPF for ash loading","Check for regen inhibitor conditions","Schedule DPF service"]},
    "P2003": {"system":"aftertreatment","component":"dpf","description":"DPF Efficiency Below Threshold (Bank 2)","severity":"critical","failure_risk":0.80,"related_dtcs":["P2002"],"co_risk_boost":1.4,"actions":["Initiate forced DPF regen","Schedule DPF service"]},
    "P242F": {"system":"aftertreatment","component":"dpf","description":"DPF Restriction — Ash Accumulation","severity":"critical","failure_risk":0.85,"related_dtcs":["P2002","P2458"],"co_risk_boost":1.5,"actions":["Schedule DPF cleaning or replacement","Check regen history"]},
    "P2458": {"system":"aftertreatment","component":"dpf","description":"DPF Regeneration Duration","severity":"warning","failure_risk":0.60,"related_dtcs":["P2002","P242F","P2459"],"co_risk_boost":1.3,"actions":["Allow regen cycle to complete","Check for inhibitor conditions (short trips)"]},
    "P2459": {"system":"aftertreatment","component":"dpf","description":"DPF Regeneration Frequency","severity":"warning","failure_risk":0.55,"related_dtcs":["P2458","P2002"],"co_risk_boost":1.2,"actions":["Check for short trip pattern driving","Inspect fuel quality","Review regen frequency history"]},
    "P20EE": {"system":"aftertreatment","component":"scr","description":"SCR NOx Catalyst Efficiency Below Threshold","severity":"critical","failure_risk":0.80,"related_dtcs":["P203F","P2047"],"co_risk_boost":1.4,"actions":["Check DEF level and quality","Inspect DEF dosing system","Test NOx sensors"]},
    "P203F": {"system":"aftertreatment","component":"def","description":"Reductant Level Sensor Performance","severity":"warning","failure_risk":0.50,"related_dtcs":["P20EE"],"co_risk_boost":1.2,"actions":["Refill DEF tank","Inspect DEF level sensor"]},

    # ── OIL SYSTEM ───────────────────────────────────────────────────────────
    "P0520": {"system":"lubrication","component":"oil_pressure_sensor","description":"Engine Oil Pressure Sensor Circuit Malfunction","severity":"critical","failure_risk":0.75,"related_dtcs":["P0521","P0522","P0524"],"co_risk_boost":1.4,"actions":["STOP engine if oil pressure warning active","Check engine oil level","Inspect oil pressure sensor","Test oil pump pressure"]},
    "P0521": {"system":"lubrication","component":"oil_pressure_sensor","description":"Engine Oil Pressure Sensor Range/Performance","severity":"critical","failure_risk":0.80,"related_dtcs":["P0520","P0524"],"co_risk_boost":1.5,"actions":["Check actual oil pressure with mechanical gauge","Inspect oil pump if pressure is genuinely low","Check for oil leaks"]},
    "P0524": {"system":"lubrication","component":"oil_pressure","description":"Engine Oil Pressure Too Low","severity":"critical","failure_risk":0.95,"related_dtcs":["P0520","P0521"],"co_risk_boost":1.6,"actions":["STOP engine immediately","Check oil level — add oil if low","Inspect for external oil leaks","Test oil pump — possible replacement needed"]},

    # ── BATTERY / CHARGING ───────────────────────────────────────────────────
    "P0560": {"system":"charging","component":"battery","description":"System Voltage Malfunction","severity":"warning","failure_risk":0.55,"related_dtcs":["P0561","P0562","P0563"],"co_risk_boost":1.3,"actions":["Test battery voltage and load","Inspect alternator output","Check battery cables and connections"]},
    "P0561": {"system":"charging","component":"battery","description":"System Voltage Unstable","severity":"warning","failure_risk":0.60,"related_dtcs":["P0560","P0562"],"co_risk_boost":1.3,"actions":["Test alternator for voltage ripple","Check battery health","Inspect grounds and connections"]},
    "P0562": {"system":"charging","component":"battery","description":"System Voltage Low","severity":"critical","failure_risk":0.75,"related_dtcs":["P0560","P0563"],"co_risk_boost":1.4,"actions":["Test battery (voltage < 12.4V under load = replace)","Inspect alternator — check charging voltage","Check for parasitic draw"]},
    "P0563": {"system":"charging","component":"battery","description":"System Voltage High","severity":"warning","failure_risk":0.50,"related_dtcs":["P0562"],"co_risk_boost":1.2,"actions":["Test alternator voltage regulator","Check for overcharging (>14.8V)"]},

    # ── TRANSMISSION ─────────────────────────────────────────────────────────
    "P0700": {"system":"transmission","component":"tcm","description":"Transmission Control System Malfunction","severity":"warning","failure_risk":0.60,"related_dtcs":["P0218","P0720","P0730"],"co_risk_boost":1.3,"actions":["Retrieve transmission-specific codes","Check transmission fluid level and condition","Inspect TCM wiring"]},
    "P0720": {"system":"transmission","component":"output_speed_sensor","description":"Output Speed Sensor Circuit Malfunction","severity":"warning","failure_risk":0.50,"related_dtcs":["P0700","P0721"],"co_risk_boost":1.2,"actions":["Inspect output speed sensor and wiring","Replace sensor if faulty"]},
    "P0730": {"system":"transmission","component":"gear_ratio","description":"Incorrect Gear Ratio","severity":"warning","failure_risk":0.65,"related_dtcs":["P0700","P0740"],"co_risk_boost":1.3,"actions":["Check transmission fluid","Inspect clutch packs","Perform transmission service"]},
    "P0740": {"system":"transmission","component":"torque_converter","description":"Torque Converter Clutch Solenoid Circuit Malfunction","severity":"warning","failure_risk":0.55,"related_dtcs":["P0700","P0730"],"co_risk_boost":1.2,"actions":["Inspect TCC solenoid","Check transmission fluid condition"]},

    # ── SENSOR FAULTS ────────────────────────────────────────────────────────
    "P0335": {"system":"engine","component":"crankshaft_sensor","description":"Crankshaft Position Sensor A Circuit Malfunction","severity":"critical","failure_risk":0.85,"related_dtcs":["P0336","P0340"],"co_risk_boost":1.5,"actions":["Replace crankshaft position sensor","Inspect reluctor ring for damage","Check sensor wiring"]},
    "P0340": {"system":"engine","component":"camshaft_sensor","description":"Camshaft Position Sensor A Circuit Malfunction","severity":"critical","failure_risk":0.80,"related_dtcs":["P0335","P0341"],"co_risk_boost":1.4,"actions":["Replace camshaft position sensor","Inspect timing chain/belt","Check sensor wiring"]},
    "P0500": {"system":"drivetrain","component":"vehicle_speed_sensor","description":"Vehicle Speed Sensor Malfunction","severity":"warning","failure_risk":0.40,"related_dtcs":["P0501"],"co_risk_boost":1.1,"actions":["Inspect VSS and wiring","Test sensor output"]},

    # ── THROTTLE / PEDAL ─────────────────────────────────────────────────────
    "P0120": {"system":"fuel","component":"throttle_position_sensor","description":"Throttle/Pedal Position Sensor A Circuit Malfunction","severity":"warning","failure_risk":0.55,"related_dtcs":["P0121","P0122","P0123"],"co_risk_boost":1.2,"actions":["Inspect TPS wiring","Clean throttle body","Replace TPS if out of range"]},
    "P0121": {"system":"fuel","component":"throttle_position_sensor","description":"TPS Range/Performance Problem","severity":"warning","failure_risk":0.50,"related_dtcs":["P0120"],"co_risk_boost":1.2,"actions":["Calibrate throttle position sensor","Clean throttle body"]},

    # ── TURBOCHARGER ─────────────────────────────────────────────────────────
    "P0234": {"system":"engine","component":"turbocharger","description":"Turbocharger/Supercharger Overboost Condition","severity":"critical","failure_risk":0.80,"related_dtcs":["P0235","P0236","P0299"],"co_risk_boost":1.4,"actions":["Check boost pressure actuator","Inspect wastegate/VGT solenoid","Check for boost leaks"]},
    "P0299": {"system":"engine","component":"turbocharger","description":"Turbocharger/Supercharger Underboost Condition","severity":"warning","failure_risk":0.65,"related_dtcs":["P0234","P0235"],"co_risk_boost":1.3,"actions":["Check for boost leaks","Inspect VGT/wastegate actuator","Check compressor wheel for damage","Inspect intercooler"]},
    "P0235": {"system":"engine","component":"boost_pressure_sensor","description":"Turbocharger Boost Pressure Sensor A Circuit","severity":"warning","failure_risk":0.45,"related_dtcs":["P0234","P0299"],"co_risk_boost":1.2,"actions":["Inspect boost pressure sensor and wiring","Replace sensor if out of range"]},

    # ── INTAKE / EXHAUST ─────────────────────────────────────────────────────
    "P0110": {"system":"engine","component":"intake_air_temp_sensor","description":"Intake Air Temperature Sensor 1 Circuit","severity":"warning","failure_risk":0.35,"related_dtcs":["P0111","P0112"],"co_risk_boost":1.1,"actions":["Check IAT sensor wiring","Replace IAT sensor if reading implausible"]},
    "P0236": {"system":"engine","component":"boost_pressure_sensor","description":"Turbocharger Boost Pressure Sensor A Range/Performance","severity":"warning","failure_risk":0.40,"related_dtcs":["P0235","P0299"],"co_risk_boost":1.1,"actions":["Inspect boost sensor lines for blockage","Replace sensor if drifting"]},

    # ── HVAC / MISC ──────────────────────────────────────────────────────────
    "P0480": {"system":"cooling","component":"cooling_fan","description":"Cooling Fan 1 Control Circuit Malfunction","severity":"warning","failure_risk":0.60,"related_dtcs":["P0481","P0217"],"co_risk_boost":1.3,"actions":["Test cooling fan motor","Inspect fan relay","Check PCM fan control output"]},
    "P0481": {"system":"cooling","component":"cooling_fan","description":"Cooling Fan 2 Control Circuit Malfunction","severity":"warning","failure_risk":0.55,"related_dtcs":["P0480","P0217"],"co_risk_boost":1.2,"actions":["Test secondary cooling fan","Inspect fan relay"]},

    # ── KNOCK / ENGINE STRESS ────────────────────────────────────────────────
    "P0325": {"system":"engine","component":"knock_sensor","description":"Knock Sensor 1 Circuit Malfunction","severity":"warning","failure_risk":0.50,"related_dtcs":["P0326","P0327","P0300"],"co_risk_boost":1.2,"actions":["Test knock sensor resistance","Inspect mounting and wiring","Monitor for actual knock with scope"]},
    "P0326": {"system":"engine","component":"knock_sensor","description":"Knock Sensor 1 Range/Performance","severity":"warning","failure_risk":0.55,"related_dtcs":["P0325","P0300"],"co_risk_boost":1.2,"actions":["Replace knock sensor if confirmed","Check fuel octane","Inspect for carbon buildup"]},
}

# Known multi-code failure signatures (co-occurrence patterns that dramatically raise risk)
CO_OCCURRENCE_SIGNATURES = [
    {
        "name": "cooling_cascade_failure",
        "codes": ["P0217", "P0128", "P0480"],
        "min_match": 2,
        "risk_boost": 1.6,
        "system": "cooling",
        "description": "Multiple cooling system codes — imminent overheating risk"
    },
    {
        "name": "dpf_critical_stack",
        "codes": ["P2002", "P242F", "P2458", "P2459"],
        "min_match": 2,
        "risk_boost": 1.5,
        "system": "aftertreatment",
        "description": "Multiple DPF codes — filter near or at capacity"
    },
    {
        "name": "fuel_system_failure",
        "codes": ["P0087", "P0251", "P0300", "P0171"],
        "min_match": 2,
        "risk_boost": 1.5,
        "system": "fuel",
        "description": "Fuel delivery and misfire codes together — injection system degradation"
    },
    {
        "name": "critical_oil_loss",
        "codes": ["P0524", "P0521", "P0300"],
        "min_match": 2,
        "risk_boost": 1.7,
        "system": "lubrication",
        "description": "Low oil pressure with misfire — engine damage risk"
    },
    {
        "name": "transmission_thermal",
        "codes": ["P0218", "P0700", "P0730"],
        "min_match": 2,
        "risk_boost": 1.4,
        "system": "transmission",
        "description": "Thermal + gear/control codes — transmission service urgently needed"
    },
]


def analyze_dtcs(dtc_codes: list[str]) -> dict:
    """
    Analyze a list of DTC codes and return a risk assessment.

    Returns:
        {
          risk_score: 0.0-1.0,
          severity: "normal"|"warning"|"critical",
          systems_affected: [str],
          top_codes: [{code, system, description, severity, failure_risk, actions}],
          co_occurrence_patterns: [{name, description, risk_boost}],
          fleet_advisory: str
        }
    """
    if not dtc_codes:
        return {
            "risk_score": 0.0,
            "severity": "normal",
            "systems_affected": [],
            "top_codes": [],
            "co_occurrence_patterns": [],
            "fleet_advisory": "No active DTCs."
        }

    codes_upper = [c.upper().strip() for c in dtc_codes]
    matched = []
    for code in codes_upper:
        if code in DTC_KB:
            entry = dict(DTC_KB[code])
            entry["code"] = code
            matched.append(entry)

    # Base risk: max failure_risk among matched codes
    if not matched:
        base_risk = min(0.30, len(codes_upper) * 0.05)
        return {
            "risk_score": base_risk,
            "severity": "warning" if base_risk >= 0.20 else "normal",
            "systems_affected": ["unknown"],
            "top_codes": [{"code": c, "system": "unknown", "description": "Unknown DTC", "severity": "warning", "failure_risk": 0.3, "actions": ["Consult manufacturer DTC guide"]} for c in codes_upper[:3]],
            "co_occurrence_patterns": [],
            "fleet_advisory": f"{len(codes_upper)} unrecognized DTC code(s) — review with manufacturer guide."
        }

    # Sort by failure_risk descending
    matched.sort(key=lambda x: x["failure_risk"], reverse=True)
    base_risk = matched[0]["failure_risk"]

    # Apply co-occurrence risk boosts
    co_patterns = []
    for sig in CO_OCCURRENCE_SIGNATURES:
        hits = [c for c in sig["codes"] if c in codes_upper]
        if len(hits) >= sig["min_match"]:
            co_patterns.append({
                "name": sig["name"],
                "description": sig["description"],
                "risk_boost": sig["risk_boost"],
                "system": sig["system"],
                "matched_codes": hits
            })

    max_boost = max((p["risk_boost"] for p in co_patterns), default=1.0)
    final_risk = min(1.0, base_risk * max_boost)

    # Determine severity
    if final_risk >= 0.75 or any(m["severity"] == "critical" for m in matched):
        severity = "critical"
    elif final_risk >= 0.40 or any(m["severity"] == "warning" for m in matched):
        severity = "warning"
    else:
        severity = "normal"

    systems_affected = list(set(m["system"] for m in matched))

    # Build advisory text
    advisory_parts = [f"Active DTCs: {', '.join(codes_upper)}."]
    if co_patterns:
        advisory_parts.append(f"Co-occurrence pattern detected: {co_patterns[0]['description']}.")
    if severity == "critical":
        advisory_parts.append("Immediate service recommended.")

    return {
        "risk_score": round(final_risk, 3),
        "severity": severity,
        "systems_affected": systems_affected,
        "top_codes": [
            {
                "code": m["code"],
                "system": m["system"],
                "description": m["description"],
                "severity": m["severity"],
                "failure_risk": m["failure_risk"],
                "actions": m["actions"][:3]
            }
            for m in matched[:5]
        ],
        "co_occurrence_patterns": co_patterns,
        "fleet_advisory": " ".join(advisory_parts)
    }
