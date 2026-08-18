const HEAVY_DUTY_MAKES = new Set([
  "freightliner", "peterbilt", "kenworth", "international", "navistar",
  "mack", "western star", "volvo trucks"
]);

const OEM_STRATEGIES = [
  {
    key: "daimler_truck_heavy",
    label: "Daimler Truck charging",
    baseProfile: "daimler_truck_heavy",
    makes: ["freightliner", "western star"],
    basis: "Daimler Truck running-voltage guidance with sustained-evidence validation"
  },
  {
    key: "paccar_heavy",
    label: "PACCAR charging",
    baseProfile: "paccar_heavy",
    makes: ["peterbilt", "kenworth"],
    basis: "PACCAR battery guidance with conservative heavy-duty running thresholds"
  },
  {
    key: "volvo_group_heavy",
    label: "Volvo Group charging",
    baseProfile: "heavy_conventional",
    makes: ["volvo trucks", "mack"],
    basis: "Volvo Group heavy-duty charging strategy with sustained-evidence validation"
  },
  {
    key: "international_heavy",
    label: "International charging",
    baseProfile: "heavy_conventional",
    makes: ["international", "navistar"],
    basis: "International heavy-duty charging strategy with sustained-evidence validation"
  },
  {
    key: "gm_regulated",
    label: "GM regulated-voltage charging",
    baseProfile: "oem_regulated",
    makes: ["chevrolet", "gmc", "cadillac", "buick", "general motors", "gm"],
    basis: "GM Electric Power Management and regulated-voltage control"
  },
  {
    key: "ford_regenerative",
    label: "Ford smart-regenerative charging",
    baseProfile: "oem_regulated",
    makes: ["ford", "lincoln", "mercury"],
    basis: "Ford battery-state-aware smart-regenerative charging"
  },
  {
    key: "stellantis_ibs",
    label: "Stellantis intelligent-battery charging",
    baseProfile: "oem_regulated",
    makes: ["ram", "dodge", "chrysler", "jeep", "fiat", "stellantis"],
    basis: "Stellantis Intelligent Battery Sensor charging management"
  },
  {
    key: "toyota_managed",
    label: "Toyota managed charging",
    baseProfile: "oem_regulated",
    makes: ["toyota", "lexus"],
    basis: "Toyota battery-voltage monitoring and vehicle-specific charging control"
  },
  {
    key: "honda_managed",
    label: "Honda managed charging",
    baseProfile: "oem_regulated",
    makes: ["honda", "acura"],
    basis: "Honda computer-controlled charging strategy"
  },
  {
    key: "nissan_managed",
    label: "Nissan managed charging",
    baseProfile: "oem_regulated",
    makes: ["nissan", "infiniti"],
    basis: "Nissan battery-state-aware charging strategy"
  },
  {
    key: "hyundai_group_managed",
    label: "Hyundai Motor Group managed charging",
    baseProfile: "oem_regulated",
    makes: ["hyundai", "kia", "genesis"],
    basis: "Hyundai Motor Group managed low-voltage charging strategy"
  },
  {
    key: "bmw_group_managed",
    label: "BMW Group energy-managed charging",
    baseProfile: "oem_regulated",
    makes: ["bmw", "mini"],
    basis: "BMW Group energy-managed charging strategy"
  },
  {
    key: "mercedes_managed",
    label: "Mercedes-Benz managed charging",
    baseProfile: "oem_regulated",
    makes: ["mercedes-benz", "mercedes"],
    basis: "Mercedes-Benz energy-managed charging strategy"
  },
  {
    key: "volkswagen_group_managed",
    label: "Volkswagen Group managed charging",
    baseProfile: "oem_regulated",
    makes: ["volkswagen", "audi"],
    basis: "Volkswagen Group energy-managed charging strategy"
  },
  {
    key: "volvo_cars_managed",
    label: "Volvo Cars managed charging",
    baseProfile: "oem_regulated",
    makes: ["volvo"],
    basis: "Volvo Cars managed low-voltage charging strategy"
  },
  {
    key: "subaru_managed",
    label: "Subaru managed charging",
    baseProfile: "oem_regulated",
    makes: ["subaru"],
    basis: "Subaru computer-controlled charging strategy"
  },
  {
    key: "mazda_managed",
    label: "Mazda managed charging",
    baseProfile: "oem_regulated",
    makes: ["mazda"],
    basis: "Mazda computer-controlled charging strategy"
  },
  {
    key: "ev_low_voltage",
    label: "EV low-voltage DC-DC charging",
    baseProfile: "low_voltage_dc_dc",
    makes: ["tesla", "rivian", "lucid", "polestar"],
    basis: "Battery-electric low-voltage DC-DC support strategy"
  }
];

const STRATEGY_BY_MAKE = new Map();
for (const strategy of OEM_STRATEGIES) {
  for (const make of strategy.makes) STRATEGY_BY_MAKE.set(make, strategy);
}

const MAKE_ALIASES = new Map([
  ["chevy", "chevrolet"],
  ["general motors", "gm"],
  ["fca", "stellantis"],
  ["vw", "volkswagen"],
  ["mercedes benz", "mercedes-benz"],
  ["volvo truck", "volvo trucks"],
  ["freightliner trucks", "freightliner"],
  ["international trucks", "international"],
  ["pete", "peterbilt"]
]);

const REGULATED_CHARGING_MAKES = new Set(
  OEM_STRATEGIES
    .filter((strategy) => strategy.baseProfile === "oem_regulated")
    .flatMap((strategy) => strategy.makes)
);

const BASE_PROFILES = {
  heavy_conventional: {
    profileKey: "heavy_conventional",
    label: "Heavy-duty alternator",
    nominalTarget: 13.9,
    expectedMin: 13.7,
    expectedMax: 14.5,
    monitorThreshold: 13.7,
    warningThreshold: 13.2,
    criticalThreshold: 12.0,
    basis: "Heavy-duty OEM running-voltage guidance"
  },
  daimler_truck_heavy: {
    profileKey: "daimler_truck_heavy",
    label: "Daimler Truck charging",
    nominalTarget: 14.0,
    expectedMin: 13.7,
    expectedMax: 14.1,
    monitorThreshold: 13.7,
    warningThreshold: 13.2,
    criticalThreshold: 12.0,
    basis: "Daimler Truck published engine-running voltage range"
  },
  paccar_heavy: {
    profileKey: "paccar_heavy",
    label: "PACCAR charging",
    nominalTarget: 14.0,
    expectedMin: 12.0,
    expectedMax: 14.0,
    monitorThreshold: 13.2,
    warningThreshold: 11.9,
    criticalThreshold: 11.5,
    basis: "PACCAR operator-manual voltmeter guidance"
  },
  oem_regulated: {
    profileKey: "oem_regulated",
    label: "OEM regulated-voltage charging",
    nominalTarget: 14.0,
    expectedMin: 12.5,
    expectedMax: 15.5,
    monitorThreshold: 13.5,
    warningThreshold: 12.4,
    criticalThreshold: 11.8,
    basis: "Battery-state-aware OEM charging control"
  },
  conventional: {
    profileKey: "conventional",
    label: "Conventional alternator",
    nominalTarget: 14.0,
    expectedMin: 13.5,
    expectedMax: 14.8,
    monitorThreshold: 13.5,
    warningThreshold: 13.0,
    criticalThreshold: 12.0,
    basis: "Conventional 12-volt charging system"
  },
  low_voltage_dc_dc: {
    profileKey: "low_voltage_dc_dc",
    label: "Hybrid/EV low-voltage DC-DC system",
    nominalTarget: 13.8,
    expectedMin: 13.0,
    expectedMax: 15.0,
    monitorThreshold: 13.0,
    warningThreshold: 12.2,
    criticalThreshold: 11.6,
    basis: "Electrified-vehicle low-voltage support system"
  },
  adaptive_fallback: {
    profileKey: "adaptive_fallback",
    label: "Adaptive 12-volt charging",
    nominalTarget: 14.0,
    expectedMin: 13.5,
    expectedMax: 15.5,
    monitorThreshold: 13.5,
    warningThreshold: 12.4,
    criticalThreshold: 11.8,
    basis: "Conservative unknown-OEM fallback"
  }
};

function normalized(value) {
  return String(value || "").trim().toLowerCase();
}

function canonicalMake(value) {
  const make = normalized(value);
  return MAKE_ALIASES.get(make) || make;
}

function explicitSystemVoltage(meta) {
  const candidates = [
    meta?.systemVoltage,
    meta?.electricalSystemVoltage,
    meta?.nominalVoltage,
    meta?.batterySystemVoltage
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value >= 10 && value <= 36) return value >= 18 ? 24 : 12;
  }
  return null;
}

function isHeavyDuty(meta, make) {
  const vehicleClass = normalized(meta?.vehicleClass || meta?.class || meta?.vehicleType);
  const protocol = normalized(meta?.protocol);
  return HEAVY_DUTY_MAKES.has(make)
    || vehicleClass.includes("heavy")
    || vehicleClass.includes("class 8")
    || protocol.includes("j1939");
}

function isElectrified(meta) {
  const powertrain = normalized(meta?.powertrain || meta?.fuelType);
  return powertrain.includes("electric") || powertrain.includes("hybrid") || powertrain === "bev" || powertrain === "phev";
}

function resolveChargingProfile(vehicleMeta = {}, inferredSystemVoltage = 12) {
  const make = canonicalMake(vehicleMeta.make || vehicleMeta.manufacturer || vehicleMeta.oem);
  const systemVoltage = explicitSystemVoltage(vehicleMeta) || (Number(inferredSystemVoltage) >= 18 ? 24 : 12);
  let base = BASE_PROFILES.adaptive_fallback;
  let strategy = STRATEGY_BY_MAKE.get(make) || null;
  if (isElectrified(vehicleMeta) || strategy?.baseProfile === "low_voltage_dc_dc") base = BASE_PROFILES.low_voltage_dc_dc;
  else if (isHeavyDuty(vehicleMeta, make)) {
    const heavyProfileKeys = ["heavy_conventional", "daimler_truck_heavy", "paccar_heavy"];
    if (strategy && heavyProfileKeys.includes(strategy.baseProfile)) base = BASE_PROFILES[strategy.baseProfile];
    else {
      base = BASE_PROFILES.heavy_conventional;
      strategy = null;
    }
  }
  else if (strategy?.baseProfile && BASE_PROFILES[strategy.baseProfile]) base = BASE_PROFILES[strategy.baseProfile];
  else if (vehicleMeta.regulatedVoltageControl === false) base = BASE_PROFILES.conventional;

  const scale = systemVoltage / 12;
  return Object.assign({}, base, {
    profileKey: strategy?.key || base.profileKey,
    label: strategy?.label || base.label,
    basis: strategy?.basis || base.basis,
    oemFamily: strategy?.key || "unknown",
    calibrationClass: base.profileKey,
    make: vehicleMeta.make || vehicleMeta.manufacturer || "Unknown",
    model: vehicleMeta.model || "Unknown",
    year: Number(vehicleMeta.year || vehicleMeta.modelYear) || null,
    systemVoltage,
    nominalTarget: base.nominalTarget * scale,
    expectedMin: base.expectedMin * scale,
    expectedMax: base.expectedMax * scale,
    monitorThreshold: base.monitorThreshold * scale,
    warningThreshold: base.warningThreshold * scale,
    criticalThreshold: base.criticalThreshold * scale
  });
}

module.exports = {
  BASE_PROFILES,
  HEAVY_DUTY_MAKES,
  OEM_STRATEGIES,
  MAKE_ALIASES,
  REGULATED_CHARGING_MAKES,
  resolveChargingProfile
};
