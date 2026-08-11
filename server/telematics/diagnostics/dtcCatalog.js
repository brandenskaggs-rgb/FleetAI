/**
 * Diagnostic trouble code decoding — J1939 (heavy duty) and OBD-II (light duty).
 *
 * Turns a raw code off the CAN bus into something a driver can act on at the
 * roadside and a fleet manager can triage from a desk: plain-English cause,
 * affected system, severity, and whether the truck should keep moving.
 *
 * Two code families, deliberately kept in one catalog because the tablet and
 * the dashboard must speak about them identically:
 *
 *   J1939  SPN + FMI. The SPN says WHICH parameter is at fault (110 = engine
 *          coolant temperature); the FMI says HOW it failed (0 = data valid but
 *          above normal, most severe). Heavy trucks, buses, most Class 6-8.
 *   OBD-II Pxxxx / Cxxxx / Bxxxx / Uxxxx. Light duty, vans, pickups.
 *
 * Severity is deliberately conservative: when a code is unknown we return
 * "unknown" rather than guessing "info", because under-reporting a real fault
 * is the failure mode that strands a truck.
 */

// ── J1939 FMI table (SAE J1939-73) ────────────────────────────────────────────
// The FMI alone carries most of the severity signal. FMI 0/1/7/12 are the
// "stop driving" family: a parameter is dangerously out of range, or a
// component is not responding at all.
const FMI_TABLE = {
  0:  { text: "Value above normal range — severe",        severity: "critical" },
  1:  { text: "Value below normal range — severe",        severity: "critical" },
  2:  { text: "Data erratic, intermittent, or incorrect", severity: "warning"  },
  3:  { text: "Voltage above normal or shorted high",     severity: "warning"  },
  4:  { text: "Voltage below normal or shorted low",      severity: "warning"  },
  5:  { text: "Current below normal or open circuit",     severity: "warning"  },
  6:  { text: "Current above normal or grounded circuit", severity: "warning"  },
  7:  { text: "Mechanical system not responding properly", severity: "critical" },
  8:  { text: "Abnormal frequency, pulse width, or period", severity: "warning" },
  9:  { text: "Abnormal update rate",                     severity: "info"     },
  10: { text: "Abnormal rate of change",                  severity: "warning"  },
  11: { text: "Root cause not known",                     severity: "warning"  },
  12: { text: "Component faulty or failed",               severity: "critical" },
  13: { text: "Out of calibration",                       severity: "warning"  },
  14: { text: "Special instructions — see service manual", severity: "warning" },
  15: { text: "Value above normal — least severe",        severity: "info"     },
  16: { text: "Value above normal — moderately severe",   severity: "warning"  },
  17: { text: "Value below normal — least severe",        severity: "info"     },
  18: { text: "Value below normal — moderately severe",   severity: "warning"  },
  19: { text: "Received network data in error",           severity: "warning"  },
  20: { text: "Data drifted high",                        severity: "warning"  },
  21: { text: "Data drifted low",                         severity: "warning"  },
  31: { text: "Condition exists",                         severity: "info"     }
};

// ── J1939 SPN table ───────────────────────────────────────────────────────────
// The SPN space is enormous (thousands, many manufacturer-specific). This
// covers the parameters that actually drive roadside failures and that this
// platform already models in physics — coolant, oil, bearings, aftertreatment,
// charging. Anything unlisted decodes to a generic entry rather than being
// dropped, so an unknown SPN still reaches the fleet manager.
const SPN_TABLE = {
  84:   { name: "Wheel-based vehicle speed", system: "vehicle" },
  91:   { name: "Accelerator pedal position", system: "engine" },
  94:   { name: "Fuel delivery pressure",     system: "fuel" },
  97:   { name: "Water in fuel indicator",    system: "fuel" },
  98:   { name: "Engine oil level",           system: "engine" },
  100:  { name: "Engine oil pressure",        system: "engine", driveability: "stop" },
  102:  { name: "Intake manifold boost pressure", system: "engine" },
  105:  { name: "Intake manifold temperature", system: "engine" },
  108:  { name: "Barometric pressure",        system: "engine" },
  110:  { name: "Engine coolant temperature", system: "cooling", driveability: "stop" },
  111:  { name: "Coolant level",              system: "cooling", driveability: "stop" },
  157:  { name: "Injector rail pressure",     system: "fuel" },
  158:  { name: "Battery potential (switched)", system: "electrical" },
  168:  { name: "Battery voltage",            system: "electrical" },
  171:  { name: "Ambient air temperature",    system: "environment" },
  174:  { name: "Fuel temperature",           system: "fuel" },
  175:  { name: "Engine oil temperature",     system: "engine" },
  177:  { name: "Transmission oil temperature", system: "transmission" },
  190:  { name: "Engine speed (RPM)",         system: "engine" },
  247:  { name: "Engine total hours",         system: "engine" },
  411:  { name: "EGR differential pressure",  system: "emissions" },
  412:  { name: "EGR temperature",            system: "emissions" },
  520:  { name: "Retarder torque",            system: "driveline" },
  609:  { name: "Controller #2 (ECU) fault",  system: "electrical" },
  611:  { name: "Injector wiring shorted",    system: "fuel" },
  627:  { name: "Power supply to ECU",        system: "electrical", driveability: "stop" },
  629:  { name: "Engine control module",      system: "electrical", driveability: "stop" },
  636:  { name: "Engine position sensor",     system: "engine" },
  639:  { name: "J1939 network communication", system: "network" },
  651:  { name: "Injector cylinder 1",        system: "fuel" },
  652:  { name: "Injector cylinder 2",        system: "fuel" },
  653:  { name: "Injector cylinder 3",        system: "fuel" },
  654:  { name: "Injector cylinder 4",        system: "fuel" },
  655:  { name: "Injector cylinder 5",        system: "fuel" },
  656:  { name: "Injector cylinder 6",        system: "fuel" },
  1127: { name: "Turbocharger boost pressure", system: "engine" },
  1172: { name: "Turbocharger compressor inlet temperature", system: "engine" },
  1188: { name: "Turbocharger wastegate",    system: "engine" },
  1569: { name: "Engine protection torque derate", system: "engine", driveability: "limp" },
  3031: { name: "Aftertreatment DEF tank temperature", system: "emissions" },
  3216: { name: "Aftertreatment intake NOx", system: "emissions" },
  3226: { name: "Aftertreatment outlet NOx", system: "emissions" },
  3242: { name: "DPF intake temperature",    system: "emissions" },
  3246: { name: "DPF outlet temperature",    system: "emissions" },
  3251: { name: "DPF differential pressure", system: "emissions" },
  3361: { name: "DEF dosing unit",           system: "emissions" },
  3364: { name: "DEF quality",               system: "emissions" },
  3719: { name: "DPF soot load",             system: "emissions", driveability: "limp" },
  3720: { name: "DPF ash load",              system: "emissions" },
  4094: { name: "NOx limits — engine derate", system: "emissions", driveability: "limp" },
  4096: { name: "NOx limits — engine shutdown", system: "emissions", driveability: "stop" },
  5246: { name: "Aftertreatment SCR inducement", system: "emissions", driveability: "limp" }
};

// ── OBD-II ────────────────────────────────────────────────────────────────────
// First letter = system, second digit = generic (0) vs manufacturer (1).
const OBD_SYSTEM_LETTER = {
  P: { system: "powertrain", label: "Powertrain" },
  C: { system: "chassis",    label: "Chassis" },
  B: { system: "body",       label: "Body" },
  U: { system: "network",    label: "Network" }
};

// Common OBD-II codes with real driveability consequences. Same principle as
// the SPN table: an unlisted code still decodes and still reaches the manager.
const OBD_TABLE = {
  P0016: { name: "Crankshaft/camshaft timing misalignment", severity: "critical", driveability: "stop" },
  P0087: { name: "Fuel rail pressure too low",              severity: "critical", driveability: "limp" },
  P0101: { name: "Mass air flow circuit range/performance", severity: "warning" },
  P0113: { name: "Intake air temperature sensor high",      severity: "warning" },
  P0117: { name: "Engine coolant temperature sensor low",   severity: "warning" },
  P0118: { name: "Engine coolant temperature sensor high",  severity: "warning" },
  P0128: { name: "Coolant thermostat below regulating temperature", severity: "warning" },
  P0171: { name: "Fuel system too lean (bank 1)",           severity: "warning" },
  P0172: { name: "Fuel system too rich (bank 1)",           severity: "warning" },
  P0217: { name: "Engine overheating condition",            severity: "critical", driveability: "stop" },
  P0299: { name: "Turbocharger underboost",                 severity: "warning",  driveability: "limp" },
  P0300: { name: "Random/multiple cylinder misfire",        severity: "critical", driveability: "limp" },
  P0301: { name: "Cylinder 1 misfire",                      severity: "warning",  driveability: "limp" },
  P0401: { name: "EGR flow insufficient",                   severity: "warning" },
  P0420: { name: "Catalyst efficiency below threshold",     severity: "warning" },
  P0500: { name: "Vehicle speed sensor",                    severity: "warning" },
  P0521: { name: "Engine oil pressure sensor range/performance", severity: "critical", driveability: "stop" },
  P0562: { name: "System voltage low",                      severity: "warning" },
  P0563: { name: "System voltage high",                     severity: "warning" },
  P2002: { name: "Diesel particulate filter efficiency below threshold", severity: "warning", driveability: "limp" },
  P20EE: { name: "SCR NOx catalyst efficiency below threshold", severity: "warning", driveability: "limp" },
  P2463: { name: "Diesel particulate filter soot accumulation", severity: "warning", driveability: "limp" },
  U0100: { name: "Lost communication with ECM/PCM",         severity: "critical", driveability: "stop" }
};

const SEVERITY_RANK = { critical: 3, warning: 2, info: 1, unknown: 0 };

/** Higher of two severities, so a code never gets downgraded by combination. */
function maxSeverity(a, b) {
  return (SEVERITY_RANK[b] || 0) > (SEVERITY_RANK[a] || 0) ? b : a;
}

/**
 * Decode a J1939 SPN/FMI pair.
 * `occurrenceCount` is passed through from DM1 when the ECU supplies it.
 */
function decodeJ1939(spn, fmi, occurrenceCount = null) {
  const spnNum = Number(spn);
  const fmiNum = Number(fmi);
  const spnEntry = SPN_TABLE[spnNum] || null;
  const fmiEntry = FMI_TABLE[fmiNum] || null;

  let severity = fmiEntry ? fmiEntry.severity : "unknown";
  // A stop-rated parameter escalates: a coolant-temperature fault is more
  // serious than the same FMI on an ambient-air sensor.
  if (spnEntry?.driveability === "stop") severity = maxSeverity(severity, "critical");

  return {
    protocol: "J1939",
    code: `SPN ${spnNum} FMI ${fmiNum}`,
    spn: spnNum,
    fmi: fmiNum,
    parameter: spnEntry ? spnEntry.name : `Unrecognised parameter (SPN ${spnNum})`,
    failureMode: fmiEntry ? fmiEntry.text : `Unrecognised failure mode (FMI ${fmiNum})`,
    system: spnEntry ? spnEntry.system : "unknown",
    severity,
    driveability: spnEntry?.driveability || (severity === "critical" ? "limp" : "ok"),
    occurrenceCount: occurrenceCount == null ? null : Number(occurrenceCount),
    known: Boolean(spnEntry && fmiEntry)
  };
}

/** Decode an OBD-II code such as P0128. */
function decodeObd(rawCode) {
  const code = String(rawCode || "").trim().toUpperCase();
  const letter = code.slice(0, 1);
  const sys = OBD_SYSTEM_LETTER[letter];
  const entry = OBD_TABLE[code] || null;
  const manufacturerSpecific = /^[PCBU]1/.test(code);

  return {
    protocol: "OBD-II",
    code,
    parameter: entry
      ? entry.name
      : `${sys ? sys.label : "Unrecognised"} fault${manufacturerSpecific ? " (manufacturer-specific)" : ""}`,
    failureMode: entry ? null : "Definition not in catalog — refer to the OEM service manual",
    system: sys ? sys.system : "unknown",
    severity: entry ? entry.severity : "unknown",
    driveability: entry?.driveability || "ok",
    occurrenceCount: null,
    known: Boolean(entry)
  };
}

/**
 * Decode whatever the scanner produced. Accepts either shape:
 *   { spn, fmi, occurrenceCount }   → J1939
 *   "P0128" | { code: "P0128" }     → OBD-II
 */
function decodeCode(input) {
  if (input && typeof input === "object" && input.spn != null && input.fmi != null) {
    return decodeJ1939(input.spn, input.fmi, input.occurrenceCount ?? input.oc ?? null);
  }
  const raw = typeof input === "string" ? input : (input?.code ?? "");
  const str = String(raw).trim().toUpperCase();
  // "SPN 110 FMI 0" arriving as a string
  const j1939 = /^SPN\s*(\d+)\s*FMI\s*(\d+)$/.exec(str);
  if (j1939) return decodeJ1939(j1939[1], j1939[2], input?.occurrenceCount ?? null);
  return decodeObd(str);
}

/**
 * Summarise a decoded set for the fleet manager: worst severity, whether the
 * truck should be pulled, and per-system counts for triage.
 */
function summarize(decoded) {
  const list = Array.isArray(decoded) ? decoded : [];
  let severity = "info";
  let driveability = "ok";
  const bySystem = {};
  for (const d of list) {
    severity = maxSeverity(severity, d.severity);
    if (d.driveability === "stop") driveability = "stop";
    else if (d.driveability === "limp" && driveability !== "stop") driveability = "limp";
    bySystem[d.system] = (bySystem[d.system] || 0) + 1;
  }
  if (!list.length) severity = "info";
  return {
    total: list.length,
    severity,
    driveability,
    criticalCount: list.filter((d) => d.severity === "critical").length,
    warningCount: list.filter((d) => d.severity === "warning").length,
    unknownCount: list.filter((d) => !d.known).length,
    bySystem
  };
}

/** Driver-facing instruction. Deliberately unambiguous — no hedging. */
function driverGuidance(summary) {
  if (summary.driveability === "stop") {
    return {
      headline: "Stop when safe to do so",
      detail: "A fault was found that can damage the engine or leave you stranded. Pull over where it is safe, shut down, and call dispatch before continuing."
    };
  }
  if (summary.driveability === "limp") {
    return {
      headline: "Reduced power — get to a shop",
      detail: "The engine may derate. Continue to the nearest safe service location rather than starting a new leg."
    };
  }
  if (summary.severity === "warning") {
    return {
      headline: "Report at end of shift",
      detail: "Faults were recorded that need attention but do not require stopping. Note them on your DVIR."
    };
  }
  return { headline: "No action needed", detail: "No active faults were found on this scan." };
}

module.exports = {
  decodeCode,
  decodeJ1939,
  decodeObd,
  summarize,
  driverGuidance,
  maxSeverity,
  FMI_TABLE,
  SPN_TABLE,
  OBD_TABLE,
  SEVERITY_RANK
};
