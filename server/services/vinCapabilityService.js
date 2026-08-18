// VIN-based sensor capability detection.
// Reads VIN from J1939 SPN 237 (PGN 65260) on connection.
// Year >= 2015: native TPMS + accelerometer (newer ECU required).
// Older trucks: flagged addon_eligible for premium hardware upsell.

const db = require("../db");

// WMI (chars 0-2) → make
const WMI_MAKE = {
  "1FT": "Ford", "1FD": "Ford", "1FC": "Ford", "1FA": "Ford", "1FM": "Ford",
  "1GC": "Chevrolet", "1G1": "Chevrolet", "2G1": "Chevrolet", "3GC": "Chevrolet",
  "1GT": "GMC", "1GK": "GMC", "1G4": "Buick", "1G6": "Cadillac", "1GY": "Cadillac",
  "1C6": "Ram", "3C6": "Ram", "3D7": "Ram", "1C4": "Jeep", "1C3": "Chrysler",
  "1HG": "Honda", "2HG": "Honda", "19X": "Honda", "5FN": "Honda",
  "1N4": "Nissan", "1N6": "Nissan", "3N1": "Nissan", "JN1": "Nissan", "JN8": "Nissan",
  "1VW": "Volkswagen", "3VW": "Volkswagen", "3VV": "Volkswagen",
  "WAU": "Audi", "TRU": "Audi",
  "2T1": "Toyota", "4T1": "Toyota", "5TD": "Toyota", "5TF": "Toyota",
  "JTM": "Toyota", "JT2": "Toyota", "JTH": "Lexus", "2T2": "Lexus",
  "5NP": "Hyundai", "5NM": "Hyundai", "KMH": "Hyundai",
  "KNA": "Kia", "KND": "Kia", "5XY": "Kia",
  "JF1": "Subaru", "JF2": "Subaru", "4S3": "Subaru", "4S4": "Subaru",
  "JM1": "Mazda", "JM3": "Mazda",
  "YV1": "Volvo", "YV4": "Volvo",
  "5YJ": "Tesla", "7SA": "Tesla", "7F7": "Rivian",
  "1FU": "Freightliner", "1FV": "Freightliner", "3AK": "Freightliner", "3AL": "Freightliner",
  "5KK": "Western Star", "2WK": "Western Star", "2WL": "Western Star",
  "1XP": "Peterbilt", "1NP": "Peterbilt", "2NP": "Peterbilt",
  "1XK": "Kenworth", "1NK": "Kenworth", "2XK": "Kenworth",
  "1M1": "Mack", "1M2": "Mack", "1M3": "Mack", "1M4": "Mack",
  "1HT": "International", "1HS": "International", "2HS": "International", "3HS": "International",
  "2FZJA": "Sterling",
  "4V1": "Volvo Trucks", "4V2": "Volvo Trucks", "4VL": "Volvo Trucks",
  "4V4": "Volvo Trucks", "4V5": "Volvo Trucks", "3VT": "Volvo Trucks",
  "WDB": "Mercedes-Benz", "W1K": "Mercedes-Benz", "W1N": "Mercedes-Benz",
  "WBA": "BMW", "WBY": "BMW"
};

// VIN position 10 (index 9) → model year for the current 2000–2029 cycle.
const YEAR_CHAR = {
  Y: 2000, "1": 2001, "2": 2002, "3": 2003, "4": 2004,
  "5": 2005, "6": 2006, "7": 2007, "8": 2008, "9": 2009,
  A: 2010, B: 2011, C: 2012, D: 2013, E: 2014,
  F: 2015, G: 2016, H: 2017, J: 2018, K: 2019,
  L: 2020, M: 2021, N: 2022, P: 2023, R: 2024,
  S: 2025, T: 2026, V: 2027, W: 2028, X: 2029
};

// Core sensors every J1939 truck exposes
const CORE_SENSORS = [
  "rpm", "vehicleSpeed", "coolantTemp", "oilTemp", "batteryVoltage",
  "engineLoad", "fuelRate", "engineHours", "fuelLevel", "egtC",
  "dpfSootLoad", "intakeManifoldPressure", "transmissionTemp",
  "fuelDeliveryPressure", "engineOilPressure"
];

// Sensors only available on trucks 2015+ (native ECU support)
const MODERN_SENSORS = ["tpms", "vibration"];

// Addon hardware sensors (upsell for pre-2015)
const ADDON_SENSORS = ["tpms", "vibration", "dashcam", "trailerSensor"];

function decodeVin(vin) {
  if (!vin || typeof vin !== "string" || vin.length !== 17) return null;
  const v = vin.toUpperCase();

  // Year: position 9 (0-indexed)
  const yearChar = v[9];
  const year = YEAR_CHAR[yearChar] || null;

  // Make: longest matching WMI prefix (3–6 chars)
  let make = null;
  const prefixes = Object.keys(WMI_MAKE).sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (v.startsWith(prefix)) {
      make = WMI_MAKE[prefix];
      break;
    }
  }
  // Fallback: 3-char WMI lookup
  if (!make) make = WMI_MAKE[v.slice(0, 3)] || null;

  return { vin: v, year, make };
}

function buildCapabilityMap(vehicleId, vin) {
  const decoded = decodeVin(vin);

  if (!decoded || !decoded.year) {
    return {
      vehicleId,
      vin: vin || null,
      year: null,
      make: null,
      modelYearStr: null,
      supportedSensors: CORE_SENSORS,
      addonEligible: true,
      addonSensors: ADDON_SENSORS,
      detectedAt: new Date().toISOString()
    };
  }

  const { year, make } = decoded;
  const isModern = year >= 2015;

  const supportedSensors = isModern
    ? [...CORE_SENSORS, ...MODERN_SENSORS]
    : [...CORE_SENSORS];

  const addonSensors = isModern ? [] : ADDON_SENSORS;

  return {
    vehicleId,
    vin: decoded.vin,
    year,
    make: make || "Unknown",
    modelYearStr: `${year}`,
    supportedSensors,
    addonEligible: !isModern,
    addonSensors,
    detectedAt: new Date().toISOString()
  };
}

// Called when a VIN is decoded from SPN 237 or provided in a telemetry frame.
// Persists capabilities to PostgreSQL and returns the capability map.
async function processVin(vehicleId, vin) {
  if (!vehicleId) return null;
  try {
    const cap = buildCapabilityMap(vehicleId, vin);
    await db.upsertVehicleCapabilities(cap);
    return cap;
  } catch (err) {
    console.warn("[VIN] capability upsert failed:", err.message);
    return null;
  }
}

// Returns capabilities from DB, or builds a default if not yet seen.
async function getCapabilities(vehicleId) {
  try {
    return (await db.getVehicleCapabilities(vehicleId)) || null;
  } catch (err) {
    return null;
  }
}

module.exports = {
  decodeVin,
  buildCapabilityMap,
  processVin,
  getCapabilities,
  CORE_SENSORS,
  MODERN_SENSORS,
  ADDON_SENSORS
};
