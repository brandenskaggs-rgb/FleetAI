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
  { key: "rpm",              path: "engine.rpm",              label: "Engine speed",            unit: "rpm",  spn: 190,  pid: "0x0C", group: "engine",
    normal: [600, 2100],   redline: 2500,  precision: 0 },
  { key: "engineLoadPct",    path: "engine.engineLoadPct",    label: "Engine load",             unit: "%",    spn: 92,   pid: "0x04", group: "engine",
    normal: [0, 85],       precision: 0 },
  { key: "torquePct",        path: "engine.torquePct",        label: "Actual engine torque",    unit: "%",    spn: 513,  pid: null,   group: "engine",
    normal: [0, 90],       precision: 0 },
  { key: "coolantTempC",     path: "engine.coolantTempC",     label: "Coolant temperature",     unit: "°C",   spn: 110,  pid: "0x05", group: "engine",
    normal: [82, 96],      critical: 105, precision: 1, critical_high: true },
  { key: "oilTempC",         path: "engine.oilTempC",         label: "Oil temperature",         unit: "°C",   spn: 175,  pid: "0x5C", group: "engine",
    normal: [85, 115],     critical: 125, precision: 1, critical_high: true },
  { key: "intakeAirTempC",   path: "engine.intakeAirTempC",   label: "Intake air temperature",  unit: "°C",   spn: 105,  pid: "0x0F", group: "engine",
    normal: [-20, 60],     precision: 1 },
  { key: "mafGramsPerSec",   path: "engine.mafGramsPerSec",   label: "Mass air flow",           unit: "g/s",  spn: 132,  pid: "0x10", group: "engine",
    normal: [2, 600],      precision: 1 },
  { key: "throttlePosPct",   path: "engine.throttlePosPct",   label: "Throttle position",       unit: "%",    spn: 91,   pid: "0x11", group: "engine",
    normal: [0, 100],      precision: 0 },
  { key: "fuelRateLph",      path: "engine.fuelRateLph",      label: "Fuel rate",               unit: "L/h",  spn: 183,  pid: "0x5E", group: "fuel",
    normal: [0, 90],       precision: 1 },
  { key: "stft1",            path: "engine.stft1",            label: "Short-term fuel trim",    unit: "%",    spn: null, pid: "0x06", group: "fuel",
    normal: [-10, 10],     precision: 1, symmetric: true },
  { key: "ltft1",            path: "engine.ltft1",            label: "Long-term fuel trim",     unit: "%",    spn: null, pid: "0x07", group: "fuel",
    normal: [-10, 10],     precision: 1, symmetric: true },

  // ── Electrical ────────────────────────────────────────────────────────────
  { key: "batteryVoltageV",  path: "electrical.batteryVoltageV", label: "Battery voltage",      unit: "V",    spn: 168,  pid: "0x42", group: "electrical",
    normal: [12.4, 14.8],  critical: 11.8, precision: 2, critical_low: true },

  // ── Vehicle ───────────────────────────────────────────────────────────────
  { key: "speedKph",         path: "vehicle.speedKph",        label: "Road speed",              unit: "km/h", spn: 84,   pid: "0x0D", group: "vehicle",
    normal: [0, 120],      precision: 0 },
  { key: "odometerKm",       path: "vehicle.odometerKm",      label: "Odometer",                unit: "km",   spn: 245,  pid: null,   group: "vehicle",
    normal: null,          precision: 0 },
  { key: "engineHours",      path: "vehicle.engineHours",     label: "Engine hours",            unit: "h",    spn: 247,  pid: null,   group: "vehicle",
    normal: null,          precision: 1 },
  { key: "fuelLevelPct",     path: "vehicle.fuelLevelPct",    label: "Fuel level",              unit: "%",    spn: 96,   pid: "0x2F", group: "fuel",
    normal: [15, 100],     precision: 0, critical_low: true, critical: 8 },

  // ── Emissions / aftertreatment ────────────────────────────────────────────
  { key: "egtC",             path: "emissions.egtC",          label: "Exhaust gas temperature", unit: "°C",   spn: 173,  pid: null,   group: "emissions",
    normal: [200, 550],    critical: 700, precision: 0, critical_high: true },
  { key: "dpfSootLoadPct",   path: "emissions.dpfSootLoadPct", label: "DPF soot load",          unit: "%",    spn: 3719, pid: null,   group: "emissions",
    normal: [0, 70],       critical: 90,  precision: 0, critical_high: true },
  { key: "regenActive",      path: "emissions.regenActive",   label: "DPF regeneration active", unit: "",     spn: 3700, pid: null,   group: "emissions",
    normal: null,          boolean: true }
];

const GROUPS = [
  { key: "engine",     label: "Engine" },
  { key: "fuel",       label: "Fuel" },
  { key: "electrical", label: "Electrical" },
  { key: "emissions",  label: "Emissions" },
  { key: "vehicle",    label: "Vehicle" }
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
  const declaresSupport = supportedPids.size > 0 || supportedSpns.size > 0;

  const readings = SENSORS.map((s) => {
    const value = normalized ? readPath(normalized, s.path) : undefined;
    const present = value !== undefined && value !== null;
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
      state: present ? classify(s, value) : (isSupported ? "unknown" : "unsupported")
    };
  });

  return {
    groups: GROUPS,
    readings,
    counts: {
      total: readings.length,
      reporting: readings.filter((r) => r.value != null).length,
      unsupported: readings.filter((r) => !r.supported).length,
      watch: readings.filter((r) => r.state === "watch").length,
      critical: readings.filter((r) => r.state === "critical").length
    }
  };
}

module.exports = { SENSORS, GROUPS, buildSensorView, classify, readPath };
