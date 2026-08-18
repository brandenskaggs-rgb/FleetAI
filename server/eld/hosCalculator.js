"use strict";

const { DUTY_CODE, EVENT_TYPE, RECORD_STATUS } = require("./constants");

const MINUTE_MS = 60_000;

const RULE_PROFILES = Object.freeze({
  FEDERAL_PROPERTY_60_7: Object.freeze({
    key: "FEDERAL_PROPERTY_60_7",
    label: "Federal property carrier 60/7",
    requiredRestMinutes: 600,
    driveLimitMinutes: 660,
    drivingWindowMinutes: 840,
    breakAfterDrivingMinutes: 480,
    breakDurationMinutes: 30,
    cycleDays: 7,
    cycleLimitMinutes: 3600,
    restartMinutes: 2040
  }),
  FEDERAL_PROPERTY_70_8: Object.freeze({
    key: "FEDERAL_PROPERTY_70_8",
    label: "Federal property carrier 70/8",
    requiredRestMinutes: 600,
    driveLimitMinutes: 660,
    drivingWindowMinutes: 840,
    breakAfterDrivingMinutes: 480,
    breakDurationMinutes: 30,
    cycleDays: 8,
    cycleLimitMinutes: 4200,
    restartMinutes: 2040
  }),
  CA_INTRASTATE_PROPERTY_80_8: Object.freeze({
    key: "CA_INTRASTATE_PROPERTY_80_8",
    label: "California intrastate property carrier 80/8",
    requiredRestMinutes: 600,
    driveLimitMinutes: 720,
    drivingWindowMinutes: 960,
    breakAfterDrivingMinutes: null,
    breakDurationMinutes: null,
    cycleDays: 8,
    cycleLimitMinutes: 4800,
    restartMinutes: 2040
  })
});

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function minutes(ms) {
  return Math.max(0, ms / MINUTE_MS);
}

function zonedParts(date, timeZone) {
  const values = {};
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return values;
}

function zonedDateTimeToUtc(parts, timeZone) {
  const desiredLocalMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second || 0
  );
  let candidate = desiredLocalMs;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(new Date(candidate), timeZone);
    const actualLocalMs = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second
    );
    const correction = desiredLocalMs - actualLocalMs;
    candidate += correction;
    if (correction === 0) break;
  }
  return new Date(candidate);
}

function getCycleWindowStart(now, cycleDays, timeZone = "UTC", dayStartMinutes = 0) {
  const localNow = zonedParts(now, timeZone);
  const normalizedStartMinutes = Math.min(1439, Math.max(0, Number(dayStartMinutes) || 0));
  const localMinute = localNow.hour * 60 + localNow.minute;
  const localDate = new Date(Date.UTC(localNow.year, localNow.month - 1, localNow.day));
  if (localMinute < normalizedStartMinutes) localDate.setUTCDate(localDate.getUTCDate() - 1);
  localDate.setUTCDate(localDate.getUTCDate() - (cycleDays - 1));
  return zonedDateTimeToUtc({
    year: localDate.getUTCFullYear(),
    month: localDate.getUTCMonth() + 1,
    day: localDate.getUTCDate(),
    hour: Math.floor(normalizedStartMinutes / 60),
    minute: normalizedStartMinutes % 60,
    second: 0
  }, timeZone);
}

function overlapMinutes(start, end, rangeStart, rangeEnd) {
  return minutes(Math.max(0, Math.min(end, rangeEnd) - Math.max(start, rangeStart)));
}

function isRestStatus(code) {
  return code === DUTY_CODE.OFF_DUTY || code === DUTY_CODE.SLEEPER;
}

function isOnDutyStatus(code) {
  return code === DUTY_CODE.ON_DUTY || code === DUTY_CODE.DRIVING;
}

function buildDutyIntervals(events, now) {
  const endAt = asDate(now) || new Date();
  const points = (Array.isArray(events) ? events : [])
    .filter((event) => Number(event.eventType) === EVENT_TYPE.DUTY_STATUS)
    .filter((event) => Number(event.recordStatus ?? RECORD_STATUS.ACTIVE) === RECORD_STATUS.ACTIVE)
    .map((event) => ({ at: asDate(event.occurredAt), status: Number(event.eventCode) }))
    .filter((event) => event.at && event.at <= endAt && [1, 2, 3, 4].includes(event.status))
    .sort((a, b) => a.at - b.at);
  return points.map((point, index) => ({
    status: point.status,
    start: point.at,
    end: points[index + 1]?.at || endAt
  })).filter((interval) => interval.end > interval.start);
}

function findRestBlocks(intervals) {
  const blocks = [];
  let active = null;
  for (const interval of intervals) {
    if (isRestStatus(interval.status)) {
      if (!active || active.end.getTime() !== interval.start.getTime()) {
        if (active) blocks.push(active);
        active = { start: interval.start, end: interval.end };
      } else {
        active.end = interval.end;
      }
    } else if (active) {
      blocks.push(active);
      active = null;
    }
  }
  if (active) blocks.push(active);
  return blocks.map((block) => ({
    ...block,
    durationMinutes: minutes(block.end - block.start)
  }));
}

function calculateDrivingSinceBreak(intervals, shiftStart, now, requiredBreakMinutes) {
  let drivingMinutes = 0;
  let nonDrivingMinutes = 0;
  for (const interval of intervals) {
    const duration = overlapMinutes(
      interval.start.getTime(),
      interval.end.getTime(),
      shiftStart.getTime(),
      now.getTime()
    );
    if (duration <= 0) continue;
    if (interval.status === DUTY_CODE.DRIVING) {
      if (nonDrivingMinutes >= requiredBreakMinutes) drivingMinutes = 0;
      nonDrivingMinutes = 0;
      drivingMinutes += duration;
    } else {
      nonDrivingMinutes += duration;
    }
  }
  if (nonDrivingMinutes >= requiredBreakMinutes) return 0;
  return drivingMinutes;
}

function calculateHosStatus({
  events,
  now = new Date(),
  ruleProfile = "FEDERAL_PROPERTY_70_8",
  homeTerminalTimeZone = "UTC",
  dayStartMinutes = 0
}) {
  const profile = RULE_PROFILES[ruleProfile];
  if (!profile) throw new TypeError("Unsupported HOS rule profile: " + ruleProfile);
  const at = asDate(now);
  if (!at) throw new TypeError("now must be a valid date");
  const intervals = buildDutyIntervals(events, at);
  if (!intervals.length) {
    return {
      ruleProfile: profile.key,
      ruleLabel: profile.label,
      sufficientHistory: false,
      currentDutyCode: null,
      driveRemainingMinutes: null,
      windowRemainingMinutes: null,
      breakRemainingMinutes: null,
      cycleRemainingMinutes: null,
      drivingProhibitedReasons: ["INSUFFICIENT_HISTORY"],
      violations: [],
      warnings: ["No duty-status history is available."]
    };
  }

  const restBlocks = findRestBlocks(intervals);
  const qualifyingRest = [...restBlocks]
    .reverse()
    .find((block) => block.durationMinutes >= profile.requiredRestMinutes);
  const currentDutyCode = intervals[intervals.length - 1].status;
  const firstDutyAfterRest = qualifyingRest
    ? intervals.find((interval) => interval.start >= qualifyingRest.end && isOnDutyStatus(interval.status))
    : null;
  const shiftStart = firstDutyAfterRest?.start || null;
  const shiftHistorySufficient = Boolean(qualifyingRest);

  let drivingUsedMinutes = 0;
  let windowUsedMinutes = 0;
  let drivingSinceBreakMinutes = 0;
  if (shiftHistorySufficient && shiftStart) {
    drivingUsedMinutes = intervals
      .filter((interval) => interval.status === DUTY_CODE.DRIVING)
      .reduce((total, interval) => total + overlapMinutes(
        interval.start.getTime(),
        interval.end.getTime(),
        shiftStart.getTime(),
        at.getTime()
      ), 0);
    windowUsedMinutes = minutes(at - shiftStart);
    if (profile.breakAfterDrivingMinutes !== null) {
      drivingSinceBreakMinutes = calculateDrivingSinceBreak(
        intervals,
        shiftStart,
        at,
        profile.breakDurationMinutes
      );
    }
  }

  const cycleWindowStart = getCycleWindowStart(
    at,
    profile.cycleDays,
    homeTerminalTimeZone,
    dayStartMinutes
  );
  const restart = [...restBlocks]
    .reverse()
    .find((block) => block.durationMinutes >= profile.restartMinutes && block.end > cycleWindowStart);
  const cycleStart = restart?.end > cycleWindowStart ? restart.end : cycleWindowStart;
  const earliest = intervals[0].start;
  const cycleHistorySufficient = earliest <= cycleWindowStart || Boolean(restart);
  const cycleUsedMinutes = intervals
    .filter((interval) => isOnDutyStatus(interval.status))
    .reduce((total, interval) => total + overlapMinutes(
      interval.start.getTime(),
      interval.end.getTime(),
      cycleStart.getTime(),
      at.getTime()
    ), 0);

  const driveRemainingMinutes = shiftHistorySufficient
    ? Math.max(0, profile.driveLimitMinutes - drivingUsedMinutes)
    : null;
  const windowRemainingMinutes = shiftHistorySufficient
    ? Math.max(0, profile.drivingWindowMinutes - windowUsedMinutes)
    : null;
  const breakRemainingMinutes = profile.breakAfterDrivingMinutes === null
    ? null
    : shiftHistorySufficient
      ? Math.max(0, profile.breakAfterDrivingMinutes - drivingSinceBreakMinutes)
      : null;
  const cycleRemainingMinutes = cycleHistorySufficient
    ? Math.max(0, profile.cycleLimitMinutes - cycleUsedMinutes)
    : null;

  const violations = [];
  if (drivingUsedMinutes > profile.driveLimitMinutes) violations.push("DRIVING_LIMIT");
  if (shiftStart && windowUsedMinutes > profile.drivingWindowMinutes && currentDutyCode === DUTY_CODE.DRIVING) {
    violations.push("DRIVING_WINDOW");
  }
  if (profile.breakAfterDrivingMinutes !== null
    && drivingSinceBreakMinutes > profile.breakAfterDrivingMinutes
    && currentDutyCode === DUTY_CODE.DRIVING) {
    violations.push("BREAK_REQUIRED");
  }
  if (cycleUsedMinutes > profile.cycleLimitMinutes && currentDutyCode === DUTY_CODE.DRIVING) {
    violations.push("CYCLE_LIMIT");
  }
  const drivingProhibitedReasons = [];
  if (!shiftHistorySufficient || !cycleHistorySufficient) drivingProhibitedReasons.push("INSUFFICIENT_HISTORY");
  if (driveRemainingMinutes === 0) drivingProhibitedReasons.push("DRIVING_LIMIT_REACHED");
  if (windowRemainingMinutes === 0) drivingProhibitedReasons.push("DRIVING_WINDOW_CLOSED");
  if (breakRemainingMinutes === 0) drivingProhibitedReasons.push("BREAK_REQUIRED");
  if (cycleRemainingMinutes === 0) drivingProhibitedReasons.push("CYCLE_LIMIT_REACHED");

  const warnings = [];
  if (!shiftHistorySufficient) warnings.push("A qualifying off-duty period is not present in retained history.");
  if (!cycleHistorySufficient) warnings.push("A complete " + profile.cycleDays + "-day duty history is not available.");
  warnings.push("Split-sleeper, adverse-condition, short-haul, and specialized-operation exceptions are not applied automatically.");

  return {
    ruleProfile: profile.key,
    ruleLabel: profile.label,
    sufficientHistory: shiftHistorySufficient && cycleHistorySufficient,
    currentDutyCode,
    shiftStartedAt: shiftStart,
    lastQualifyingRestEndedAt: qualifyingRest?.end || null,
    drivingUsedMinutes: Math.round(drivingUsedMinutes),
    driveRemainingMinutes: driveRemainingMinutes === null ? null : Math.floor(driveRemainingMinutes),
    windowUsedMinutes: Math.round(windowUsedMinutes),
    windowRemainingMinutes: windowRemainingMinutes === null ? null : Math.floor(windowRemainingMinutes),
    drivingSinceBreakMinutes: Math.round(drivingSinceBreakMinutes),
    breakRemainingMinutes: breakRemainingMinutes === null ? null : Math.floor(breakRemainingMinutes),
    cycleUsedMinutes: Math.round(cycleUsedMinutes),
    cycleRemainingMinutes: cycleRemainingMinutes === null ? null : Math.floor(cycleRemainingMinutes),
    cycleWindowStartedAt: cycleWindowStart,
    requiredRestMinutes: profile.requiredRestMinutes,
    drivingProhibitedReasons,
    violations,
    warnings
  };
}

module.exports = {
  RULE_PROFILES,
  buildDutyIntervals,
  findRestBlocks,
  getCycleWindowStart,
  calculateHosStatus
};
