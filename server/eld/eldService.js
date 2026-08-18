"use strict";

const {
  EVENT_TYPE,
  DUTY_CODE,
  DUTY_NAME_BY_CODE,
  RECORD_ORIGIN,
  RECORD_STATUS,
  SPECIAL_DRIVING_CODE,
  LOGIN_CODE,
  ENGINE_POWER_CODE,
  DIAGNOSTIC_CODE,
  DIAGNOSTIC_EVENT_CODE,
  VALID_MULTIDAY_BASES,
  VEHICLE_MOVING_KPH,
  AUTO_ON_DUTY_AFTER_STOP_MS,
  INTERMEDIATE_LOG_INTERVAL_MS
} = require("./constants");
const { eventDataCheck } = require("./checksums");
const { RULE_PROFILES, calculateHosStatus } = require("./hosCalculator");
const {
  cleanField,
  eventLocalParts,
  formatCoordinate,
  formatEngineHours
} = require("./format");

const MAX_ANNOTATION_LENGTH = 60;
const ENGINE_SYNC_DIAGNOSTIC_MS = 5_000;
const ENGINE_SYNC_MALFUNCTION_MS = 30 * 60 * 1000;
const POSITIONING_MALFUNCTION_MS = 60 * 60 * 1000;
const UNIDENTIFIED_DIAGNOSTIC_MINUTES = 30;

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function asDate(value, fallback = new Date()) {
  const date = value instanceof Date ? value : new Date(value || fallback);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Invalid ELD event timestamp");
  return date;
}

function timezoneOffsetMinutes(timeZone, instant = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const localAsUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  );
  return Math.round((localAsUtc - instant.getTime()) / 60_000);
}

function requireAnnotation(value, label = "annotation") {
  const annotation = cleanField(value, MAX_ANNOTATION_LENGTH);
  if (annotation.length < 4) {
    const error = new Error(`${label} must contain at least 4 characters`);
    error.code = "ELD_ANNOTATION_REQUIRED";
    error.statusCode = 400;
    throw error;
  }
  return annotation;
}

function normalizeDutyCode(value) {
  if (Number.isInteger(value) && DUTY_NAME_BY_CODE[value]) return value;
  const key = String(value || "").trim().toUpperCase();
  const aliases = {
    OFF: "OFF_DUTY",
    ON: "ON_DUTY",
    SB: "SLEEPER",
    SLEEPER_BERTH: "SLEEPER"
  };
  return DUTY_CODE[aliases[key] || key] || null;
}

function normalizeCoordinates(input, reducedPrecision) {
  const latitude = finite(input?.latitude);
  const longitude = finite(input?.longitude);
  const valid = latitude !== null && longitude !== null
    && latitude >= -90 && latitude <= 90
    && longitude >= -180 && longitude <= 180;
  if (!valid) {
    const missingCode = cleanField(input?.locationCode || "X", 1).toUpperCase();
    const code = ["X", "M", "E"].includes(missingCode) ? missingCode : "X";
    return { latitude: null, longitude: null, latitudeCode: code, longitudeCode: code };
  }
  const digits = reducedPrecision ? 1 : 2;
  return {
    latitude: Number(latitude.toFixed(digits)),
    longitude: Number(longitude.toFixed(digits)),
    latitudeCode: "",
    longitudeCode: ""
  };
}

function extractTelemetry(normalized) {
  const source = normalized || {};
  const vehicle = source.vehicle || {};
  const engine = source.engine || {};
  const meta = source.meta || {};
  const speedKph = finite(vehicle.speedKph ?? source.speedKph);
  const odometerKm = finite(vehicle.odometerKm ?? source.odometerKm);
  const engineHours = finite(vehicle.engineHours ?? source.engineHours);
  const rpm = finite(engine.rpm ?? source.rpm);
  return {
    speedKph,
    totalVehicleMiles: odometerKm === null ? null : Math.max(0, Math.round(odometerKm * 0.621371)),
    totalEngineHours: engineHours,
    engineOn: rpm === null ? null : rpm > 0,
    latitude: finite(meta.latitude ?? source.latitude),
    longitude: finite(meta.longitude ?? source.longitude)
  };
}

function createEldService(prisma) {
  if (!prisma) throw new TypeError("Prisma client is required");

  async function getCarrierConfig(orgId, client = prisma) {
    return client.eldCarrierConfig.findUnique({ where: { orgId } });
  }

  async function getDeviceContext(device, client = prisma) {
    const [state, config, vehicle, driver, diagnostics] = await Promise.all([
      client.eldDeviceState.findUnique({ where: { deviceId: device.deviceId } }),
      getCarrierConfig(device.orgId, client),
      client.vehicle.findUnique({ where: { vehicleId: device.vehicleId } }),
      device.driverId ? client.driver.findUnique({ where: { driverId: device.driverId } }) : null,
      client.eldDiagnostic.findMany({
        where: { deviceId: device.deviceId, status: "DETECTED" },
        orderBy: { detectedAt: "asc" }
      })
    ]);
    return { state, config, vehicle, driver, diagnostics };
  }

  async function configureCarrier(orgId, input) {
    const carrierName = cleanField(input.carrierName, 120);
    const usdotNumber = cleanField(input.usdotNumber, 8);
    const homeTerminalName = cleanField(input.homeTerminalName, 120);
    const homeTerminalAddress = cleanField(input.homeTerminalAddress, 240);
    const homeTerminalTimeZone = cleanField(input.homeTerminalTimeZone, 80);
    const multidayBasis = cleanField(input.multidayBasis || "US_70_8", 16);
    const defaultRuleProfile = multidayBasis === "US_60_7"
      ? "FEDERAL_PROPERTY_60_7"
      : "FEDERAL_PROPERTY_70_8";
    const hosRuleProfile = cleanField(input.hosRuleProfile || defaultRuleProfile, 40).toUpperCase();
    if (!carrierName || !/^\d{1,8}$/.test(usdotNumber) || !homeTerminalName || !homeTerminalAddress) {
      const error = new Error("carrierName, a numeric USDOT number, homeTerminalName, and homeTerminalAddress are required");
      error.statusCode = 400;
      throw error;
    }
    if (!VALID_MULTIDAY_BASES.has(multidayBasis)) {
      const error = new Error("multidayBasis must be US_60_7 or US_70_8");
      error.statusCode = 400;
      throw error;
    }
    if (!RULE_PROFILES[hosRuleProfile]) {
      const error = new Error("hosRuleProfile must be FEDERAL_PROPERTY_60_7, FEDERAL_PROPERTY_70_8, or CA_INTRASTATE_PROPERTY_80_8");
      error.statusCode = 400;
      throw error;
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: homeTerminalTimeZone }).format(new Date());
    } catch (_) {
      const error = new Error("homeTerminalTimeZone must be a valid IANA time zone");
      error.statusCode = 400;
      throw error;
    }
    const data = {
      carrierName,
      usdotNumber,
      homeTerminalName,
      homeTerminalAddress,
      homeTerminalTimeZone,
      dayStartMinutes: Math.min(1439, Math.max(0, Number(input.dayStartMinutes) || 0)),
      multidayBasis,
      hosRuleProfile,
      personalConveyance: input.personalConveyance === true,
      yardMove: input.yardMove === true
    };
    return prisma.eldCarrierConfig.upsert({
      where: { orgId },
      create: { orgId, ...data },
      update: data
    });
  }

  async function configureProviderIdentity(orgId, input) {
    const eldIdentifier = cleanField(input.eldIdentifier, 6).toUpperCase();
    const eldRegistrationId = cleanField(input.eldRegistrationId, 40);
    const eldProvider = cleanField(input.eldProvider || "Fleet AI", 120);
    const certifiedSoftwareVersion = cleanField(input.certifiedSoftwareVersion, 40);
    const certificationState = cleanField(input.certificationState || "TESTING", 20).toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(eldIdentifier)) {
      const error = new Error("eldIdentifier must be exactly six uppercase letters or numbers");
      error.statusCode = 400;
      throw error;
    }
    if (!eldRegistrationId || !certifiedSoftwareVersion || !["DEVELOPMENT", "TESTING", "REGISTERED"].includes(certificationState)) {
      const error = new Error("eldRegistrationId, certifiedSoftwareVersion, and a valid certificationState are required");
      error.statusCode = 400;
      throw error;
    }
    if (certificationState === "REGISTERED" && process.env.ELD_FMCSA_LISTING_CONFIRMED !== "true") {
      const error = new Error("The version cannot be marked registered until its public FMCSA listing is confirmed");
      error.code = "FMCSA_LISTING_NOT_CONFIRMED";
      error.statusCode = 409;
      throw error;
    }
    return prisma.eldCarrierConfig.update({
      where: { orgId },
      data: { eldIdentifier, eldRegistrationId, eldProvider, certifiedSoftwareVersion, certificationState }
    });
  }

  async function configureDriver(orgId, driverId, input) {
    const driver = await prisma.driver.findUnique({ where: { driverId } });
    if (!driver || driver.orgId !== orgId) {
      const error = new Error("Driver not found in this organization");
      error.statusCode = 404;
      throw error;
    }
    const eldUsername = cleanField(input.eldUsername, 60);
    const licenseState = cleanField(input.licenseState, 2).toUpperCase();
    const licenseNum = cleanField(input.licenseNum, 32);
    if (!/^[A-Za-z0-9._-]{4,60}$/.test(eldUsername)) {
      const error = new Error("ELD username must be 4-60 letters, numbers, dots, underscores, or hyphens");
      error.statusCode = 400;
      throw error;
    }
    if (licenseNum && eldUsername.toLowerCase().includes(licenseNum.toLowerCase())) {
      const error = new Error("ELD username cannot contain the driver's license number");
      error.statusCode = 400;
      throw error;
    }
    if (!/^[A-Z]{2}$/.test(licenseState) || licenseNum.length < 2) {
      const error = new Error("A two-letter licenseState and licenseNum are required");
      error.statusCode = 400;
      throw error;
    }
    return prisma.driver.update({
      where: { driverId },
      data: {
        eldUsername,
        licenseState,
        licenseNum,
        eldExempt: input.eldExempt === true
      }
    });
  }

  async function enableDevice(device, enabled) {
    const context = await getDeviceContext(device);
    const blockers = [];
    if (!context.config) blockers.push("carrier_configuration");
    if (!context.vehicle?.vin || context.vehicle.vin.length !== 17) blockers.push("vehicle_vin");
    if (device.driverId && (!context.driver?.eldUsername || !context.driver?.licenseNum || !context.driver?.licenseState)) {
      blockers.push("driver_eld_profile");
    }
    if (enabled && blockers.length) {
      const error = new Error(`ELD cannot be enabled until these items are complete: ${blockers.join(", ")}`);
      error.code = "ELD_CONFIGURATION_INCOMPLETE";
      error.statusCode = 409;
      error.blockers = blockers;
      throw error;
    }
    return prisma.eldDeviceState.upsert({
      where: { deviceId: device.deviceId },
      create: {
        deviceId: device.deviceId,
        orgId: device.orgId,
        vehicleId: device.vehicleId,
        currentDriverId: null,
        enabled: Boolean(enabled)
      },
      update: {
        orgId: device.orgId,
        vehicleId: device.vehicleId,
        enabled: Boolean(enabled)
      }
    });
  }

  async function createEventInTransaction(tx, device, input) {
    const occurredAt = asDate(input.occurredAt);
    const context = await getDeviceContext(device, tx);
      if (!context.state?.enabled) {
        const error = new Error("ELD mode is not enabled for this paired device");
        error.code = "ELD_NOT_ENABLED";
        error.statusCode = 409;
        throw error;
      }
      if (!context.config) {
        const error = new Error("Carrier ELD configuration is missing");
        error.statusCode = 409;
        throw error;
      }
      if (input.requireStopped === true && context.state.vehicleMoving) {
        const error = new Error("Duty status cannot be changed while the vehicle is moving");
        error.code = "ELD_VEHICLE_MOVING";
        error.statusCode = 409;
        throw error;
      }

      const offset = timezoneOffsetMinutes(context.config.homeTerminalTimeZone, occurredAt);
      const local = eventLocalParts(occurredAt, offset);
      const reducedPrecision = Number(input.eventType) === EVENT_TYPE.SPECIAL_DRIVING
        && Number(input.eventCode) === SPECIAL_DRIVING_CODE.PERSONAL_CONVEYANCE;
      const coordinates = normalizeCoordinates(input, reducedPrecision);
      const driverId = input.driverId === undefined ? (device.driverId || null) : input.driverId;
      const driver = driverId
        ? (driverId === context.driver?.driverId ? context.driver : await tx.driver.findUnique({ where: { driverId } }))
        : null;
      if (driver && driver.orgId !== device.orgId) {
        const error = new Error("Driver does not belong to this organization");
        error.statusCode = 403;
        throw error;
      }
      const origin = Number(input.recordOrigin);
      const eldUsername = origin === RECORD_ORIGIN.UNIDENTIFIED
        ? "UNIDENTIFIED"
        : cleanField(input.eldUsername || driver?.eldUsername, 60);
      if (!eldUsername && Number(input.eventType) !== EVENT_TYPE.ENGINE_POWER) {
        const error = new Error("Driver ELD profile is incomplete");
        error.code = "ELD_DRIVER_PROFILE_INCOMPLETE";
        error.statusCode = 409;
        throw error;
      }

      const totalMiles = finite(input.totalVehicleMiles);
      const totalHours = finite(input.totalEngineHours);
      const startMiles = finite(context.state.powerCycleStartMiles);
      const startHours = finite(context.state.powerCycleStartEngineHours);
      const accumulatedMiles = input.accumulatedVehicleMiles ?? (
        totalMiles !== null && startMiles !== null ? Math.max(0, Math.round(totalMiles - startMiles)) : null
      );
      const elapsedHours = input.elapsedEngineHours ?? (
        totalHours !== null && startHours !== null ? Math.max(0, totalHours - startHours) : null
      );
      const latitudeForCheck = coordinates.latitudeCode || formatCoordinate(coordinates.latitude, reducedPrecision);
      const longitudeForCheck = coordinates.longitudeCode || formatCoordinate(coordinates.longitude, reducedPrecision);
      const vehicleMilesForCheck = Number(input.eventType) === EVENT_TYPE.ENGINE_POWER
        ? (totalMiles === null ? "" : String(Math.round(totalMiles)))
        : (accumulatedMiles === null ? "" : String(Math.round(accumulatedMiles)));
      const engineHoursForCheck = Number(input.eventType) === EVENT_TYPE.ENGINE_POWER
        ? formatEngineHours(totalHours)
        : formatEngineHours(elapsedHours);
      const cmvPowerUnitNumber = cleanField(context.vehicle?.unitName || context.vehicle?.vehicleId, 10);
      const eventCheck = eventDataCheck({
        eventType: input.eventType,
        eventCode: input.eventCode,
        eventDate: local.eventDate,
        eventTime: local.eventTime,
        vehicleMiles: vehicleMilesForCheck,
        engineHours: engineHoursForCheck,
        latitude: latitudeForCheck,
        longitude: longitudeForCheck,
        cmvPowerUnitNumber,
        eldUsername
      });

      const sequenceId = context.state.sequenceCounter & 0xffff;
      const wrapped = sequenceId === 0xffff;
      const stateUpdate = {
        sequenceCounter: wrapped ? 0 : sequenceId + 1,
        sequenceEpoch: wrapped ? context.state.sequenceEpoch + 1 : context.state.sequenceEpoch,
        lastRecordAt: occurredAt,
        ...(input.statePatch || {})
      };
      const event = await tx.eldEvent.create({
        data: {
          orgId: device.orgId,
          vehicleId: device.vehicleId,
          driverId,
          deviceId: device.deviceId,
          sequenceId,
          sequenceEpoch: context.state.sequenceEpoch,
          recordStatus: Number(input.recordStatus || RECORD_STATUS.ACTIVE),
          recordOrigin: origin,
          eventType: Number(input.eventType),
          eventCode: Number(input.eventCode),
          occurredAt,
          ...local,
          timezoneOffsetMinutes: offset,
          accumulatedVehicleMiles: accumulatedMiles === null ? null : Math.max(0, Math.round(accumulatedMiles)),
          elapsedEngineHours: elapsedHours === null ? null : Number(elapsedHours.toFixed(1)),
          totalVehicleMiles: totalMiles === null ? null : Math.max(0, Math.round(totalMiles)),
          totalEngineHours: totalHours === null ? null : Number(totalHours.toFixed(1)),
          ...coordinates,
          distanceSinceCoordinatesKm: finite(input.distanceSinceCoordinatesKm),
          locationDescription: cleanField(input.locationDescription, 60),
          annotation: cleanField(input.annotation, MAX_ANNOTATION_LENGTH),
          eldUsername,
          cmvPowerUnitNumber,
          cmvVin: cleanField(context.vehicle?.vin, 17),
          trailerNumbers: cleanField(input.trailerNumbers, 32),
          shippingDocumentNumber: cleanField(input.shippingDocumentNumber, 40),
          malfunctionIndicator: context.diagnostics.some((item) => item.kind === "MALFUNCTION"),
          diagnosticIndicator: context.diagnostics.some((item) => item.kind === "DIAGNOSTIC"),
          malfunctionDiagnosticCode: cleanField(input.malfunctionDiagnosticCode, 1),
          eventDataCheck: eventCheck,
          relatedEventId: input.relatedEventId || null,
          metadata: input.metadata || {}
        }
      });
      await tx.eldDeviceState.update({ where: { deviceId: device.deviceId }, data: stateUpdate });
      return event;
  }

  async function serializableTransaction(work) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await prisma.$transaction(work, { isolationLevel: "Serializable" });
      } catch (error) {
        lastError = error;
        if (error?.code !== "P2034" || attempt === 2) throw error;
      }
    }
    throw lastError;
  }

  async function createEvent(device, input) {
    return serializableTransaction((tx) => createEventInTransaction(tx, device, input));
  }

  async function createDutyStatus(device, input, options = {}) {
    const dutyCode = normalizeDutyCode(input.dutyStatus ?? input.eventCode);
    if (!dutyCode) {
      const error = new Error("dutyStatus must be OFF_DUTY, SLEEPER, DRIVING, or ON_DUTY");
      error.statusCode = 400;
      throw error;
    }
    if (dutyCode === DUTY_CODE.DRIVING && options.automatic !== true) {
      const error = new Error("Driving status is recorded automatically from vehicle motion and cannot be manually created");
      error.code = "ELD_DRIVING_AUTOMATIC_ONLY";
      error.statusCode = 409;
      throw error;
    }
    const recordOrigin = options.automatic
      ? (device.driverId ? RECORD_ORIGIN.AUTOMATIC : RECORD_ORIGIN.UNIDENTIFIED)
      : RECORD_ORIGIN.DRIVER;
    return createEvent(device, {
      ...input,
      eventType: EVENT_TYPE.DUTY_STATUS,
      eventCode: dutyCode,
      recordOrigin,
      driverId: device.driverId || null,
      requireStopped: options.automatic !== true,
      statePatch: { currentDutyCode: dutyCode, currentDriverId: device.driverId || null }
    });
  }

  async function createLoginLogout(device, code, input = {}) {
    if (![LOGIN_CODE.LOGIN, LOGIN_CODE.LOGOUT].includes(code)) throw new TypeError("Invalid login/logout code");
    return createEvent(device, {
      ...input,
      eventType: EVENT_TYPE.LOGIN_LOGOUT,
      eventCode: code,
      recordOrigin: RECORD_ORIGIN.AUTOMATIC,
      statePatch: code === LOGIN_CODE.LOGIN
        ? { currentDriverId: device.driverId || null }
        : { currentDriverId: null }
    });
  }

  async function setSpecialDriving(device, input = {}) {
    const requested = String(input.category || "").trim().toUpperCase();
    const code = requested === "PERSONAL_CONVEYANCE"
      ? SPECIAL_DRIVING_CODE.PERSONAL_CONVEYANCE
      : requested === "YARD_MOVE"
        ? SPECIAL_DRIVING_CODE.YARD_MOVE
        : requested === "CLEAR" || requested === "CLEARED"
          ? SPECIAL_DRIVING_CODE.CLEARED
          : null;
    if (code === null) {
      const error = new Error("category must be PERSONAL_CONVEYANCE, YARD_MOVE, or CLEAR");
      error.statusCode = 400;
      throw error;
    }
    const context = await getDeviceContext(device);
    if (context.state?.vehicleMoving) {
      const error = new Error("Special driving categories cannot be changed while the vehicle is moving");
      error.code = "ELD_VEHICLE_MOVING";
      error.statusCode = 409;
      throw error;
    }
    if (code === SPECIAL_DRIVING_CODE.PERSONAL_CONVEYANCE && !context.config?.personalConveyance) {
      const error = new Error("Personal conveyance is not enabled by this motor carrier");
      error.statusCode = 403;
      throw error;
    }
    if (code === SPECIAL_DRIVING_CODE.YARD_MOVE && !context.config?.yardMove) {
      const error = new Error("Yard move is not enabled by this motor carrier");
      error.statusCode = 403;
      throw error;
    }
    const annotation = requireAnnotation(input.annotation);
    return serializableTransaction(async (tx) => {
      const event = await createEventInTransaction(tx, device, {
        ...input,
        eventType: EVENT_TYPE.SPECIAL_DRIVING,
        eventCode: code,
        recordOrigin: RECORD_ORIGIN.DRIVER,
        annotation,
        requireStopped: true,
        statePatch: { specialDrivingCode: code || null }
      });
      const dutyCode = code === SPECIAL_DRIVING_CODE.PERSONAL_CONVEYANCE
        ? DUTY_CODE.OFF_DUTY
        : code === SPECIAL_DRIVING_CODE.YARD_MOVE
          ? DUTY_CODE.ON_DUTY
          : null;
      if (dutyCode !== null) {
        await createEventInTransaction(tx, device, {
          ...input,
          eventType: EVENT_TYPE.DUTY_STATUS,
          eventCode: dutyCode,
          recordOrigin: RECORD_ORIGIN.DRIVER,
          annotation,
          requireStopped: true,
          statePatch: { currentDutyCode: dutyCode, currentDriverId: device.driverId || null }
        });
      }
      return event;
    });
  }

  async function certifyRecords(device, recordDate, annotation = "Driver certification") {
    const date = cleanField(recordDate, 6);
    if (!/^\d{6}$/.test(date)) {
      const error = new Error("recordDate must use YYMMDD format");
      error.statusCode = 400;
      throw error;
    }
    return serializableTransaction(async (tx) => {
      const priorCount = await tx.eldRecordCertification.count({
        where: { driverId: device.driverId, recordDate: date }
      });
      const certificationNumber = Math.min(9, priorCount + 1);
      const event = await createEventInTransaction(tx, device, {
        eventType: EVENT_TYPE.CERTIFICATION,
        eventCode: certificationNumber,
        recordOrigin: RECORD_ORIGIN.DRIVER,
        annotation: cleanField(annotation, MAX_ANNOTATION_LENGTH),
        metadata: { certifiedRecordDate: date }
      });
      await tx.eldRecordCertification.create({
        data: {
          orgId: device.orgId,
          driverId: device.driverId,
          deviceId: device.deviceId,
          recordDate: date,
          certificationNumber,
          eventId: event.id,
          certifiedAt: event.occurredAt
        }
      });
      return event;
    });
  }

  async function driverEdit(device, eventId, input) {
    const annotation = requireAnnotation(input.annotation);
    return serializableTransaction(async (tx) => {
      const original = await tx.eldEvent.findUnique({ where: { id: eventId } });
      if (!original || original.orgId !== device.orgId || original.driverId !== device.driverId) {
        const error = new Error("ELD event not found");
        error.statusCode = 404;
        throw error;
      }
      if (original.recordStatus !== RECORD_STATUS.ACTIVE) {
        const error = new Error("Only an active ELD event can be edited");
        error.statusCode = 409;
        throw error;
      }
      if (original.eventType !== EVENT_TYPE.DUTY_STATUS) {
        const error = new Error("Drivers may edit duty-status records only");
        error.statusCode = 409;
        throw error;
      }
      if (original.eventType === EVENT_TYPE.DUTY_STATUS && original.eventCode === DUTY_CODE.DRIVING) {
        const error = new Error("Automatically recorded driving time cannot be shortened or reassigned by a direct edit");
        error.statusCode = 409;
        throw error;
      }
      const replacement = await createEventInTransaction(tx, device, {
        occurredAt: input.occurredAt || original.occurredAt,
        eventType: original.eventType,
        eventCode: normalizeDutyCode(input.dutyStatus) || original.eventCode,
        recordOrigin: RECORD_ORIGIN.DRIVER,
        annotation,
        locationDescription: input.locationDescription || original.locationDescription,
        totalVehicleMiles: original.totalVehicleMiles,
        totalEngineHours: original.totalEngineHours,
        latitude: original.latitude,
        longitude: original.longitude,
        relatedEventId: original.id,
        metadata: { editReason: annotation }
      });
      await tx.eldEvent.update({
        where: { id: original.id },
        data: { recordStatus: RECORD_STATUS.INACTIVE_CHANGED }
      });
      return replacement;
    });
  }

  async function listRecords(device, query = {}) {
    const from = asDate(query.from || Date.now() - 8 * 24 * 60 * 60 * 1000);
    const to = asDate(query.to || new Date());
    const driverId = query.driverId || device.driverId || null;
    return prisma.eldEvent.findMany({
      where: {
        orgId: device.orgId,
        ...(driverId ? { driverId } : {}),
        occurredAt: { gte: from, lte: to }
      },
      orderBy: [{ occurredAt: "desc" }, { sequenceEpoch: "desc" }, { sequenceId: "desc" }],
      take: Math.min(5000, Math.max(1, Number(query.limit) || 1000))
    });
  }

  async function setDiagnostic(device, kind, code, detected, detail = {}, occurredAt = new Date()) {
    const normalizedKind = kind === "MALFUNCTION" ? "MALFUNCTION" : "DIAGNOSTIC";
    return serializableTransaction(async (tx) => {
      const existing = await tx.eldDiagnostic.findFirst({
        where: { deviceId: device.deviceId, kind: normalizedKind, code, status: "DETECTED" }
      });
      if (detected && existing) return existing;
      if (!detected && !existing) return null;
      const eventCode = detected
        ? (normalizedKind === "MALFUNCTION" ? DIAGNOSTIC_EVENT_CODE.MALFUNCTION_DETECTED : DIAGNOSTIC_EVENT_CODE.DIAGNOSTIC_DETECTED)
        : (normalizedKind === "MALFUNCTION" ? DIAGNOSTIC_EVENT_CODE.MALFUNCTION_CLEARED : DIAGNOSTIC_EVENT_CODE.DIAGNOSTIC_CLEARED);
      const event = await createEventInTransaction(tx, device, {
        eventType: EVENT_TYPE.MALFUNCTION_DIAGNOSTIC,
        eventCode,
        recordOrigin: RECORD_ORIGIN.AUTOMATIC,
        occurredAt,
        malfunctionDiagnosticCode: code,
        metadata: detail
      });
      if (detected) {
        return tx.eldDiagnostic.create({
          data: {
            orgId: device.orgId,
            vehicleId: device.vehicleId,
            driverId: device.driverId || null,
            deviceId: device.deviceId,
            kind: normalizedKind,
            code,
            detectedAt: asDate(occurredAt),
            eventId: event.id,
            detail
          }
        });
      }
      return tx.eldDiagnostic.update({
        where: { id: existing.id },
        data: { status: "CLEARED", clearedAt: asDate(occurredAt), eventId: event.id, detail }
      });
    });
  }

  async function processTelemetry(device, normalized, timestamp) {
    const state = await prisma.eldDeviceState.findUnique({ where: { deviceId: device.deviceId } });
    if (!state?.enabled) return { enabled: false, events: [] };
    const now = asDate(timestamp);
    if (state.lastTelemetryAt && now.getTime() < state.lastTelemetryAt.getTime()) {
      return { enabled: true, outOfOrder: true, events: [] };
    }
    const telemetry = extractTelemetry(normalized);
    const elapsedMs = state.lastTelemetryAt
      ? Math.max(0, Math.min(5 * 60 * 1000, now.getTime() - state.lastTelemetryAt.getTime()))
      : 0;
    const hasVehicleSpeed = telemetry.speedKph !== null;
    // A missing speed sample is an engine-sync problem, not proof that the
    // truck stopped. Retain the last motion state until a valid speed arrives.
    const moving = hasVehicleSpeed
      ? telemetry.speedKph >= VEHICLE_MOVING_KPH
      : state.vehicleMoving;
    const completeEngineSync = telemetry.engineOn !== null
      && telemetry.speedKph !== null
      && telemetry.totalVehicleMiles !== null
      && telemetry.totalEngineHours !== null;
    const hasPosition = telemetry.latitude !== null && telemetry.longitude !== null;
    const engineSyncLossMs = completeEngineSync ? 0 : Number(state.engineSyncLossMs) + elapsedMs;
    const positioningLossMotionMs = moving && !hasPosition
      ? Number(state.positioningLossMotionMs) + elapsedMs
      : (hasPosition ? 0 : Number(state.positioningLossMotionMs));

    await prisma.eldDeviceState.update({
      where: { deviceId: device.deviceId },
      data: {
        lastTelemetryAt: now,
        lastEngineSyncAt: completeEngineSync ? now : state.lastEngineSyncAt,
        lastPositionAt: hasPosition ? now : state.lastPositionAt,
        engineSyncLossMs: BigInt(Math.round(engineSyncLossMs)),
        positioningLossMotionMs: BigInt(Math.round(positioningLossMotionMs))
      }
    });

    if (engineSyncLossMs >= ENGINE_SYNC_DIAGNOSTIC_MS) {
      await setDiagnostic(device, "DIAGNOSTIC", DIAGNOSTIC_CODE.ENGINE_SYNC, true, { engineSyncLossMs }, now);
    } else {
      await setDiagnostic(device, "DIAGNOSTIC", DIAGNOSTIC_CODE.ENGINE_SYNC, false, { engineSyncLossMs: 0 }, now);
    }
    if (engineSyncLossMs >= ENGINE_SYNC_MALFUNCTION_MS) {
      await setDiagnostic(device, "MALFUNCTION", DIAGNOSTIC_CODE.ENGINE_SYNC, true, { engineSyncLossMs }, now);
    } else if (completeEngineSync) {
      await setDiagnostic(device, "MALFUNCTION", DIAGNOSTIC_CODE.ENGINE_SYNC, false, { engineSyncLossMs: 0 }, now);
    }
    if (positioningLossMotionMs >= POSITIONING_MALFUNCTION_MS) {
      await setDiagnostic(device, "MALFUNCTION", DIAGNOSTIC_CODE.POSITIONING, true, { positioningLossMotionMs }, now);
    } else if (hasPosition) {
      await setDiagnostic(device, "MALFUNCTION", DIAGNOSTIC_CODE.POSITIONING, false, { positioningLossMotionMs: 0 }, now);
    }

    const common = {
      occurredAt: now,
      totalVehicleMiles: telemetry.totalVehicleMiles,
      totalEngineHours: telemetry.totalEngineHours,
      latitude: telemetry.latitude,
      longitude: telemetry.longitude
    };
    const events = [];
    let latestState = await prisma.eldDeviceState.findUnique({ where: { deviceId: device.deviceId } });

    if (telemetry.engineOn === true && !latestState.ignitionOn) {
      events.push(await createEvent(device, {
        ...common,
        eventType: EVENT_TYPE.ENGINE_POWER,
        eventCode: ENGINE_POWER_CODE.POWER_UP_CONVENTIONAL,
        recordOrigin: RECORD_ORIGIN.AUTOMATIC,
        driverId: null,
        eldUsername: "",
        statePatch: {
          ignitionOn: true,
          powerCycleStartedAt: now,
          powerCycleStartMiles: telemetry.totalVehicleMiles,
          powerCycleStartEngineHours: telemetry.totalEngineHours
        }
      }));
      latestState = await prisma.eldDeviceState.findUnique({ where: { deviceId: device.deviceId } });
    } else if (telemetry.engineOn === false && latestState.ignitionOn) {
      events.push(await createEvent(device, {
        ...common,
        eventType: EVENT_TYPE.ENGINE_POWER,
        eventCode: ENGINE_POWER_CODE.SHUT_DOWN_CONVENTIONAL,
        recordOrigin: RECORD_ORIGIN.AUTOMATIC,
        driverId: null,
        eldUsername: "",
        statePatch: { ignitionOn: false, vehicleMoving: false, stoppedAt: now }
      }));
      latestState = await prisma.eldDeviceState.findUnique({ where: { deviceId: device.deviceId } });
    }

    if (hasVehicleSpeed && moving && !latestState.vehicleMoving) {
      events.push(await createDutyStatus(device, { ...common, dutyStatus: "DRIVING" }, { automatic: true }));
      await prisma.eldDeviceState.update({
        where: { deviceId: device.deviceId },
        data: { vehicleMoving: true, motionStartedAt: now, stoppedAt: null }
      });
    } else if (hasVehicleSpeed && !moving && latestState.vehicleMoving) {
      await prisma.eldDeviceState.update({
        where: { deviceId: device.deviceId },
        data: { vehicleMoving: false, stoppedAt: now }
      });
    } else if (hasVehicleSpeed && !moving && latestState.currentDutyCode === DUTY_CODE.DRIVING && latestState.stoppedAt
      && now.getTime() - latestState.stoppedAt.getTime() >= AUTO_ON_DUTY_AFTER_STOP_MS) {
      events.push(await createDutyStatus(device, { ...common, dutyStatus: "ON_DUTY" }, { automatic: true }));
    }

    latestState = await prisma.eldDeviceState.findUnique({ where: { deviceId: device.deviceId } });
    if (moving && (!latestState.lastIntermediateAt
      || now.getTime() - latestState.lastIntermediateAt.getTime() >= INTERMEDIATE_LOG_INTERVAL_MS)) {
      events.push(await createEvent(device, {
        ...common,
        eventType: EVENT_TYPE.INTERMEDIATE_LOG,
        eventCode: latestState.specialDrivingCode === SPECIAL_DRIVING_CODE.PERSONAL_CONVEYANCE ? 2 : 1,
        recordOrigin: device.driverId ? RECORD_ORIGIN.AUTOMATIC : RECORD_ORIGIN.UNIDENTIFIED,
        driverId: device.driverId || null,
        statePatch: { lastIntermediateAt: now }
      }));
    }

    if (!device.driverId && moving && elapsedMs > 0) {
      const addedMinutes = Math.ceil(elapsedMs / 60_000);
      const unidentifiedMinutes = latestState.unidentifiedDrivingMinutes + addedMinutes;
      await prisma.eldDeviceState.update({
        where: { deviceId: device.deviceId },
        data: { unidentifiedDrivingMinutes: unidentifiedMinutes }
      });
      if (unidentifiedMinutes > UNIDENTIFIED_DIAGNOSTIC_MINUTES) {
        await setDiagnostic(device, "DIAGNOSTIC", DIAGNOSTIC_CODE.UNIDENTIFIED_DRIVING, true, { unidentifiedMinutes }, now);
      }
    }
    return { enabled: true, events };
  }

  async function readiness(orgId) {
    const config = await getCarrierConfig(orgId);
    const devices = await prisma.eldDeviceState.findMany({ where: { orgId } });
    const drivers = await prisma.driver.findMany({ where: { orgId, status: "active" } });
    const checks = {
      carrierConfiguration: Boolean(config?.carrierName && config?.usdotNumber && config?.homeTerminalTimeZone),
      driverProfiles: drivers.length > 0 && drivers.every((driver) => driver.eldUsername && driver.licenseNum && driver.licenseState),
      deviceEnrollment: devices.some((device) => device.enabled),
      fmcsaRegistration: Boolean(config?.eldIdentifier && config?.eldRegistrationId),
      certifiedVersion: config?.certificationState === "REGISTERED",
      dataTransferCredentials: Boolean(process.env.FMCSA_ELD_CLIENT_CERT && process.env.FMCSA_ELD_CLIENT_KEY),
      offlineEngine: process.env.ELD_OFFLINE_ENGINE_COMPLETE === "true",
      hosEngineValidated: process.env.ELD_HOS_ENGINE_VALIDATED === "true",
      roadsideDisplay: process.env.ELD_ROADSIDE_DISPLAY_COMPLETE === "true",
      transferImplementation: process.env.ELD_TRANSFER_IMPLEMENTATION_COMPLETE === "true",
      independentComplianceReview: process.env.ELD_INDEPENDENT_REVIEW_COMPLETE === "true",
      fieldValidation: process.env.ELD_FIELD_VALIDATION_COMPLETE === "true",
      fmcsaListingConfirmed: process.env.ELD_FMCSA_LISTING_CONFIRMED === "true"
    };
    return {
      ready: Object.values(checks).every(Boolean),
      checks,
      certificationState: config?.certificationState || "NOT_CONFIGURED",
      enabledDeviceCount: devices.filter((device) => device.enabled).length
    };
  }

  async function getHosStatus(device, now = new Date()) {
    const context = await getDeviceContext(device);
    if (!context.state?.enabled) {
      const error = new Error("ELD mode is not enabled for this paired device");
      error.code = "ELD_NOT_ENABLED";
      error.statusCode = 409;
      throw error;
    }
    if (!device.driverId) {
      const error = new Error("A logged-in driver is required for HOS status");
      error.code = "ELD_DRIVER_REQUIRED";
      error.statusCode = 409;
      throw error;
    }
    const at = asDate(now);
    const historyStart = new Date(at.getTime() - 10 * 24 * 60 * 60 * 1000);
    const eventWhere = {
      orgId: device.orgId,
      driverId: device.driverId,
      eventType: EVENT_TYPE.DUTY_STATUS,
      recordStatus: RECORD_STATUS.ACTIVE
    };
    const [priorEvent, recentEvents] = await Promise.all([
      prisma.eldEvent.findFirst({
        where: { ...eventWhere, occurredAt: { lt: historyStart } },
        orderBy: [{ occurredAt: "desc" }, { sequenceEpoch: "desc" }, { sequenceId: "desc" }]
      }),
      prisma.eldEvent.findMany({
        where: { ...eventWhere, occurredAt: { gte: historyStart, lte: at } },
        orderBy: [{ occurredAt: "asc" }, { sequenceEpoch: "asc" }, { sequenceId: "asc" }],
        take: 10000
      })
    ]);
    const events = priorEvent ? [priorEvent, ...recentEvents] : recentEvents;
    return calculateHosStatus({
      events,
      now: at,
      homeTerminalTimeZone: context.config?.homeTerminalTimeZone || "UTC",
      dayStartMinutes: context.config?.dayStartMinutes || 0,
      ruleProfile: context.config?.hosRuleProfile || (
        context.config?.multidayBasis === "US_60_7"
          ? "FEDERAL_PROPERTY_60_7"
          : "FEDERAL_PROPERTY_70_8"
      )
    });
  }

  return {
    getCarrierConfig,
    configureCarrier,
    configureProviderIdentity,
    configureDriver,
    enableDevice,
    getDeviceContext,
    createEvent,
    createDutyStatus,
    createLoginLogout,
    setSpecialDriving,
    certifyRecords,
    driverEdit,
    listRecords,
    setDiagnostic,
    processTelemetry,
    getHosStatus,
    readiness,
    normalizeDutyCode
  };
}

module.exports = {
  createEldService,
  timezoneOffsetMinutes,
  normalizeDutyCode,
  extractTelemetry,
  normalizeCoordinates
};
