/**
 * Catalog of every signal this platform can read off the CAN bus.
 *
 * Mirrors the canonical shape produced by
 * server/telematics/normalize/normalizeMetrics.js — engine / electrical /
 * vehicle / emissions — so the tablet's sensor list and the normalizer can
 * never drift apart. Each entry carries the J1939 SPN and/or OBD-II PID it
 * comes from, its unit, and a normal operating band used to render a live
 * reading as nominal / watch / critical without a round trip to the model.
 *
 * `path` is the dotted location inside a normalized snapshot, so a reading can
 * be resolved generically rather than with a switch statement per sensor.
 */

const SENSORS = [
  // ── Engine ────────────────────────────────────────────────────────────────
  { key: "rpm",              path: "engine.rpm",              label: "Engine speed",            unit: "rpm",  spn: 190,  pid: "010C", group: "engine",
    normal: [600, 2100],   redline: 2500,  precision: 0 },
  { key: "engineLoadPct",    path: "engine.engineLoadPct",    label: "Engine load",             unit: "%",    spn: 92,   pid: "0104", group: "engine",
    normal: [0, 85],       precision: 0 },
  { key: "torquePct",        path: "engine.torquePct",        label: "Actual engine torque",    unit: "%",    spn: 513,  pid: null,   group: "engine",
    normal: [0, 90],       precision: 0 },
  { key: "coolantTempC",     path: "engine.coolantTempC",     label: "Coolant temperature",     unit: "°C",   spn: 110,  pid: "0105", group: "engine",
    normal: [82, 96],      critical: 105, precision: 1, critical_high: true },
  { key: "oilTempC",         path: "engine.oilTempC",         label: "Oil temperature",         unit: "°C",   spn: 175,  pid: "015C", group: "engine",
    normal: [85, 115],     critical: 125, precision: 1, critical_high: true },
  { key: "intakeAirTempC",   path: "engine.intakeAirTempC",   label: "Intake air temperature",  unit: "°C",   spn: 105,  pid: "010F", group: "engine",
    normal: [-20, 60],     precision: 1 },
  { key: "mafGramsPerSec",   path: "engine.mafGramsPerSec",   label: "Mass air flow",           unit: "g/s",  spn: 132,  pid: "0110", group: "engine",
    normal: [2, 600],      precision: 1 },
  { key: "throttlePosPct",   path: "engine.throttlePosPct",   label: "Throttle position",       unit: "%",    spn: 91,   pid: "0111", group: "engine",
    normal: [0, 100],      precision: 0 },
  { key: "fuelRateLph",      path: "engine.fuelRateLph",      label: "Fuel rate",               unit: "L/h",  spn: 183,  pid: "015E", group: "fuel",
    normal: [0, 90],       precision: 1 },
  { key: "stft1",            path: "engine.shortTermFuelTrimBank1Pct", label: "Short-term fuel trim B1", unit: "%", spn: null, pid: "0106", group: "fuel",
    normal: [-10, 10],     precision: 1, symmetric: true },
  { key: "ltft1",            path: "engine.longTermFuelTrimBank1Pct", label: "Long-term fuel trim B1", unit: "%", spn: null, pid: "0107", group: "fuel",
    normal: [-10, 10],     precision: 1, symmetric: true },

  // ── Electrical ────────────────────────────────────────────────────────────
  { key: "batteryVoltageV",  path: "electrical.batteryVoltageV", label: "Battery voltage",      unit: "V",    spn: 168,  pid: "0142", group: "electrical",
    normal: [12.4, 14.8],  critical: 11.8, precision: 2, critical_low: true },

  // ── Vehicle ───────────────────────────────────────────────────────────────
  { key: "speedKph",         path: "vehicle.speedKph",        label: "Road speed",              unit: "km/h", spn: 84,   pid: "010D", group: "vehicle",
    normal: [0, 120],      precision: 0 },
  { key: "odometerKm",       path: "vehicle.odometerKm",      label: "Odometer",                unit: "km",   spn: 245,  pid: null,   group: "vehicle",
    normal: null,          precision: 0 },
  { key: "engineHours",      path: "vehicle.engineHours",     label: "Engine hours",            unit: "h",    spn: 247,  pid: null,   group: "vehicle",
    normal: null,          precision: 1 },
  { key: "fuelLevelPct",     path: "vehicle.fuelLevelPct",    label: "Fuel level",              unit: "%",    spn: 96,   pid: "012F", group: "fuel",
    normal: [15, 100],     precision: 0, critical_low: true, critical: 8 },

  // ── Emissions / aftertreatment ────────────────────────────────────────────
  { key: "egtC",             path: "emissions.egtC",          label: "Exhaust gas temperature", unit: "°C",   spn: 173,  pid: null,   group: "emissions",
    normal: [200, 550],    critical: 700, precision: 0, critical_high: true },
  { key: "dpfSootLoadPct",   path: "emissions.dpfSootLoadPct", label: "DPF soot load",          unit: "%",    spn: 3719, pid: null,   group: "emissions",
    normal: [0, 70],       critical: 90,  precision: 0, critical_high: true },
  { key: "regenActive",      path: "emissions.regenActive",   label: "DPF regeneration active", unit: "",     spn: 3700, pid: null,   group: "emissions",
    normal: null,          boolean: true },

  { key: "mapKpa", path: "engine.mapKpa", label: "Intake manifold pressure", unit: "kPa", spn: 102, pid: "010B", group: "engine", normal: null, precision: 1 },
  { key: "absoluteLoadPct", path: "engine.absoluteLoadPct", label: "Absolute engine load", unit: "%", spn: null, pid: "0143", group: "engine", normal: null, precision: 1 },
  { key: "ignitionTimingAdvanceDeg", path: "engine.ignitionTimingAdvanceDeg", label: "Ignition timing advance", unit: "°", spn: null, pid: "010E", group: "engine", normal: null, precision: 1 },
  { key: "referenceTorqueNm", path: "engine.referenceTorqueNm", label: "Engine reference torque", unit: "Nm", spn: 544, pid: "0163", group: "engine", normal: null, precision: 0 },
  { key: "actualTorquePct", path: "engine.actualTorquePct", label: "ECU actual torque", unit: "%", spn: 513, pid: "0162", group: "engine", normal: null, precision: 1 },
  { key: "driverDemandTorquePct", path: "engine.driverDemandTorquePct", label: "Driver demand torque", unit: "%", spn: 512, pid: "0161", group: "engine", normal: null, precision: 0 },

  { key: "stft2", path: "engine.shortTermFuelTrimBank2Pct", label: "Short-term fuel trim B2", unit: "%", spn: null, pid: "0108", group: "fuel", normal: [-10, 10], precision: 1 },
  { key: "ltft2", path: "engine.longTermFuelTrimBank2Pct", label: "Long-term fuel trim B2", unit: "%", spn: null, pid: "0109", group: "fuel", normal: [-10, 10], precision: 1 },
  { key: "fuelPressureKpa", path: "engine.fuelPressureKpa", label: "Fuel pressure", unit: "kPa", spn: null, pid: "010A", group: "fuel", normal: null, precision: 1 },
  { key: "fuelRailPressureRelativeKpa", path: "engine.fuelRailPressureRelativeKpa", label: "Fuel rail pressure (relative)", unit: "kPa", spn: null, pid: "0122", group: "fuel", normal: null, precision: 1 },
  { key: "fuelRailGaugePressureKpa", path: "engine.fuelRailGaugePressureKpa", label: "Fuel rail pressure (gauge)", unit: "kPa", spn: null, pid: "0123", group: "fuel", normal: null, precision: 0 },
  { key: "fuelRailAbsolutePressureKpa", path: "engine.fuelRailAbsolutePressureKpa", label: "Fuel rail absolute pressure", unit: "kPa", spn: 157, pid: "0159", group: "fuel", normal: null, precision: 0 },
  { key: "fuelInjectionTimingDeg", path: "engine.fuelInjectionTimingDeg", label: "Fuel injection timing", unit: "°", spn: null, pid: "015D", group: "fuel", normal: null, precision: 1 },
  { key: "commandedEquivalenceRatio", path: "engine.commandedEquivalenceRatio", label: "Commanded equivalence ratio", unit: "λ", spn: null, pid: "0144", group: "fuel", normal: null, precision: 3 },
  { key: "ethanolFuelPct", path: "fuel.ethanolFuelPct", label: "Ethanol content", unit: "%", spn: null, pid: "0152", group: "fuel", normal: null, precision: 1 },

  { key: "o2B1S1VoltageV", path: "emissions.o2B1S1VoltageV", label: "Oxygen sensor B1S1", unit: "V", spn: null, pid: "0114", group: "emissions", normal: null, precision: 3 },
  { key: "o2B1S2VoltageV", path: "emissions.o2B1S2VoltageV", label: "Oxygen sensor B1S2", unit: "V", spn: null, pid: "0115", group: "emissions", normal: null, precision: 3 },
  { key: "o2B2S1VoltageV", path: "emissions.o2B2S1VoltageV", label: "Oxygen sensor B2S1", unit: "V", spn: null, pid: "0118", group: "emissions", normal: null, precision: 3 },
  { key: "o2B2S2VoltageV", path: "emissions.o2B2S2VoltageV", label: "Oxygen sensor B2S2", unit: "V", spn: null, pid: "0119", group: "emissions", normal: null, precision: 3 },
  { key: "catalystTempB1S1C", path: "emissions.catalystTempB1S1C", label: "Catalyst temperature B1S1", unit: "°C", spn: null, pid: "013C", group: "emissions", normal: null, precision: 1 },
  { key: "catalystTempB2S1C", path: "emissions.catalystTempB2S1C", label: "Catalyst temperature B2S1", unit: "°C", spn: null, pid: "013D", group: "emissions", normal: null, precision: 1 },
  { key: "catalystTempB1S2C", path: "emissions.catalystTempB1S2C", label: "Catalyst temperature B1S2", unit: "°C", spn: null, pid: "013E", group: "emissions", normal: null, precision: 1 },
  { key: "catalystTempB2S2C", path: "emissions.catalystTempB2S2C", label: "Catalyst temperature B2S2", unit: "°C", spn: null, pid: "013F", group: "emissions", normal: null, precision: 1 },
  { key: "commandedEgrPct", path: "emissions.commandedEgrPct", label: "Commanded EGR", unit: "%", spn: null, pid: "012C", group: "emissions", normal: null, precision: 1 },
  { key: "egrErrorPct", path: "emissions.egrErrorPct", label: "EGR error", unit: "%", spn: null, pid: "012D", group: "emissions", normal: null, precision: 1 },
  { key: "commandedEvapPurgePct", path: "emissions.commandedEvapPurgePct", label: "Evaporative purge", unit: "%", spn: null, pid: "012E", group: "emissions", normal: null, precision: 1 },
  { key: "evapSystemVaporPressurePa", path: "emissions.evapSystemVaporPressurePa", label: "Evaporative system pressure", unit: "Pa", spn: null, pid: "0132", group: "emissions", normal: null, precision: 0 },
  { key: "absoluteEvapVaporPressureKpa", path: "emissions.absoluteEvapVaporPressureKpa", label: "Absolute evaporative pressure", unit: "kPa", spn: null, pid: "0153", group: "emissions", normal: null, precision: 2 },
  { key: "evapSystemVaporPressureWidePa", path: "emissions.evapSystemVaporPressureWidePa", label: "Evaporative pressure (wide range)", unit: "Pa", spn: null, pid: "0154", group: "emissions", normal: null, precision: 0 },

  { key: "relativeThrottlePosPct", path: "controls.relativeThrottlePosPct", label: "Relative throttle position", unit: "%", spn: null, pid: "0145", group: "controls", normal: null, precision: 1 },
  { key: "absoluteThrottleBPosPct", path: "controls.absoluteThrottleBPosPct", label: "Absolute throttle position B", unit: "%", spn: null, pid: "0147", group: "controls", normal: null, precision: 1 },
  { key: "absoluteThrottleCPosPct", path: "controls.absoluteThrottleCPosPct", label: "Absolute throttle position C", unit: "%", spn: null, pid: "0148", group: "controls", normal: null, precision: 1 },
  { key: "acceleratorPedalDPosPct", path: "controls.acceleratorPedalDPosPct", label: "Accelerator pedal D", unit: "%", spn: null, pid: "0149", group: "controls", normal: null, precision: 1 },
  { key: "acceleratorPedalEPosPct", path: "controls.acceleratorPedalEPosPct", label: "Accelerator pedal E", unit: "%", spn: null, pid: "014A", group: "controls", normal: null, precision: 1 },
  { key: "acceleratorPedalFPosPct", path: "controls.acceleratorPedalFPosPct", label: "Accelerator pedal F", unit: "%", spn: null, pid: "014B", group: "controls", normal: null, precision: 1 },
  { key: "relativeAcceleratorPedalPct", path: "controls.relativeAcceleratorPedalPct", label: "Relative accelerator pedal", unit: "%", spn: null, pid: "015A", group: "controls", normal: null, precision: 1 },
  { key: "acceleratorPedalPosPct", path: "controls.acceleratorPedalPosPct", label: "Accelerator pedal position", unit: "%", spn: 91, pid: null, group: "controls", normal: null, precision: 1 },
  { key: "commandedThrottleActuatorPct", path: "controls.commandedThrottleActuatorPct", label: "Commanded throttle actuator", unit: "%", spn: null, pid: "014C", group: "controls", normal: null, precision: 1 },

  { key: "brakePedalPositionPct", path: "brakes.brakePedalPositionPct", label: "Brake pedal position", unit: "%", spn: 521, pid: null, group: "brakes", normal: [0, 100], precision: 1 },
  { key: "serviceBrakeActive", path: "brakes.serviceBrakeActive", label: "Service brake active", unit: "", spn: 1121, pid: null, group: "brakes", normal: null, boolean: true },
  { key: "absActive", path: "brakes.absActive", label: "ABS active", unit: "", spn: 563, pid: null, group: "brakes", normal: null, boolean: true },
  { key: "tractionControlBrakeActive", path: "brakes.tractionControlBrakeActive", label: "Traction brake active", unit: "", spn: 562, pid: null, group: "brakes", normal: null, boolean: true },

  { key: "engineRunTimeSec", path: "engine.engineRunTimeSec", label: "Engine run time", unit: "s", spn: null, pid: "011F", group: "lifecycle", normal: null, precision: 0 },
  { key: "distanceWithMilOnKm", path: "vehicle.distanceWithMilOnKm", label: "Distance with warning lamp on", unit: "km", spn: null, pid: "0121", group: "lifecycle", normal: null, precision: 0 },
  { key: "warmupsSinceClear", path: "vehicle.warmupsSinceClear", label: "Warm-ups since codes cleared", unit: "count", spn: null, pid: "0130", group: "lifecycle", normal: null, precision: 0 },
  { key: "distanceSinceClearKm", path: "vehicle.distanceSinceClearKm", label: "Distance since codes cleared", unit: "km", spn: null, pid: "0131", group: "lifecycle", normal: null, precision: 0 },
  { key: "milRunTimeMin", path: "vehicle.milRunTimeMin", label: "Run time with warning lamp on", unit: "min", spn: null, pid: "014D", group: "lifecycle", normal: null, precision: 0 },
  { key: "timeSinceClearMin", path: "vehicle.timeSinceClearMin", label: "Time since codes cleared", unit: "min", spn: null, pid: "014E", group: "lifecycle", normal: null, precision: 0 },
  { key: "hybridBatteryRemainingPct", path: "vehicle.hybridBatteryRemainingPct", label: "Hybrid battery remaining", unit: "%", spn: null, pid: "015B", group: "electrical", normal: null, precision: 1 },
  { key: "odometerKmObd", path: "vehicle.odometerKm", label: "OBD odometer", unit: "km", spn: 245, pid: "01A6", group: "lifecycle", normal: null, precision: 1 },
  { key: "ambientTempC", path: "environment.ambientTempC", label: "Ambient air temperature", unit: "°C", spn: 171, pid: "0146", group: "environment", normal: null, precision: 1 },
  { key: "barometricPressureKpa", path: "environment.barometricPressureKpa", label: "Barometric pressure", unit: "kPa", spn: 108, pid: "0133", group: "environment", normal: null, precision: 1 }
];

const GROUPS = [
  { key: "engine",     label: "Engine" },
  { key: "fuel",       label: "Fuel" },
  { key: "electrical", label: "Electrical" },
  { key: "emissions",  label: "Emissions" },
  { key: "vehicle",    label: "Vehicle" },
  { key: "controls",   label: "Driver controls" },
  { key: "brakes",     label: "Brakes" },
  { key: "lifecycle",  label: "Lifecycle" },
  { key: "environment", label: "Environment" }
];

/** Read a dotted path out of a normalized snapshot. */
function readPath(obj, dotted) {
  return String(dotted).split(".").reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

/**
 * Classify a live reading against its normal band.
 * Returns nominal | watch | critical | unknown. `unknown` when the bus does not
 * report the signal at all, which is itself information for the driver: a
 * missing reading can mean an unsupported PID or a dead sensor.
 */
function classify(sensor, value) {
  if (value == null || Number.isNaN(Number(value))) return "unknown";
  if (sensor.boolean) return "nominal";
  const v = Number(value);
  if (sensor.critical != null) {
    if (sensor.critical_high && v >= sensor.critical) return "critical";
    if (sensor.critical_low && v <= sensor.critical) return "critical";
  }
  if (!Array.isArray(sensor.normal)) return "nominal";
  const [lo, hi] = sensor.normal;
  return v < lo || v > hi ? "watch" : "nominal";
}

/**
 * Build the full sensor view for a vehicle from a normalized snapshot.
 * Signals absent from the snapshot are still returned, marked unsupported, so
 * the driver can see what this truck's bus does NOT expose rather than being
 * shown a silently shorter list.
 */
function buildSensorView(normalized, supported = {}) {
  const supportedPids = new Set((supported.supportedPids || []).map((p) => String(p).toLowerCase()));
  const supportedSpns = new Set((supported.supportedSpns || []).map((s) => Number(s)));
  const metricAgesMs = supported.metricAgesMs && typeof supported.metricAgesMs === "object"
    ? supported.metricAgesMs
    : {};
  const declaresSupport = supportedPids.size > 0 || supportedSpns.size > 0;

  const readings = SENSORS.map((s) => {
    const value = normalized ? readPath(normalized, s.path) : undefined;
    const ageMs = Number(metricAgesMs[s.key]);
    const stale = Number.isFinite(ageMs) && ageMs > 30_000;
    const present = value !== undefined && value !== null && !stale;
    // If the ECU published a capability list, trust it; otherwise infer from
    // whether a value actually arrived.
    const isSupported = declaresSupport
      ? (s.spn != null && supportedSpns.has(s.spn)) || (s.pid && supportedPids.has(String(s.pid).toLowerCase()))
      : present;
    return {
      key: s.key,
      label: s.label,
      unit: s.unit,
      group: s.group,
      spn: s.spn,
      pid: s.pid,
      normal: s.normal,
      value: present ? Number(Number(value).toFixed(s.precision ?? 2)) : null,
      raw: present ? value : null,
      boolean: Boolean(s.boolean),
      supported: Boolean(isSupported),
      ageMs: Number.isFinite(ageMs) ? ageMs : null,
      stale,
      state: present ? classify(s, value) : (stale ? "stale" : (isSupported ? "unknown" : "unsupported"))
    };
  });

  return {
    groups: GROUPS,
    readings,
    counts: {
      total: readings.length,
      reporting: readings.filter((r) => r.value != null).length,
      unsupported: readings.filter((r) => !r.supported).length,
      stale: readings.filter((r) => r.stale).length,
      watch: readings.filter((r) => r.state === "watch").length,
      critical: readings.filter((r) => r.state === "critical").length
    }
  };
}

module.exports = { SENSORS, GROUPS, buildSensorView, classify, readPath };
