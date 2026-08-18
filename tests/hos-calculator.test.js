"use strict";

const assert = require("assert");
const { calculateHosStatus } = require("../server/eld/hosCalculator");

function event(at, code) {
  return { occurredAt: at, eventType: 1, eventCode: code, recordStatus: 1 };
}

function check(name, fn) {
  try {
    fn();
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    process.stderr.write(`FAIL ${name}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

check("federal property clocks follow 10/11/14 and 8-hour break rules", () => {
  const status = calculateHosStatus({
    now: "2026-08-18T14:00:00Z",
    events: [
      event("2026-08-16T00:00:00Z", 1),
      event("2026-08-18T10:00:00Z", 4),
      event("2026-08-18T11:00:00Z", 3),
      event("2026-08-18T14:00:00Z", 4)
    ]
  });
  assert.equal(status.driveRemainingMinutes, 480);
  assert.equal(status.windowRemainingMinutes, 600);
  assert.equal(status.breakRemainingMinutes, 300);
  assert.deepEqual(status.violations, []);
});

check("30 consecutive non-driving minutes reset the federal break clock", () => {
  const status = calculateHosStatus({
    now: "2026-08-18T18:30:00Z",
    events: [
      event("2026-08-16T00:00:00Z", 1),
      event("2026-08-18T10:00:00Z", 3),
      event("2026-08-18T14:00:00Z", 4),
      event("2026-08-18T14:30:00Z", 3)
    ]
  });
  assert.equal(status.drivingUsedMinutes, 480);
  assert.equal(status.drivingSinceBreakMinutes, 240);
  assert.equal(status.breakRemainingMinutes, 240);
});

check("off-duty time does not pause the ordinary 14-hour window", () => {
  const status = calculateHosStatus({
    now: "2026-08-19T00:30:00Z",
    events: [
      event("2026-08-16T00:00:00Z", 1),
      event("2026-08-18T10:00:00Z", 4),
      event("2026-08-18T11:00:00Z", 3),
      event("2026-08-18T12:00:00Z", 1),
      event("2026-08-18T18:00:00Z", 3)
    ]
  });
  assert.equal(status.windowRemainingMinutes, 0);
  assert.ok(status.violations.includes("DRIVING_WINDOW"));
});

check("California intrastate profile uses 12/16/80 and does not invent a federal break", () => {
  const status = calculateHosStatus({
    ruleProfile: "CA_INTRASTATE_PROPERTY_80_8",
    now: "2026-08-18T21:00:00Z",
    events: [
      event("2026-08-16T00:00:00Z", 1),
      event("2026-08-18T09:00:00Z", 3)
    ]
  });
  assert.equal(status.driveRemainingMinutes, 0);
  assert.equal(status.windowRemainingMinutes, 240);
  assert.equal(status.breakRemainingMinutes, null);
});

check("cycle window uses the carrier-designated home-terminal day boundary", () => {
  const status = calculateHosStatus({
    now: "2026-08-18T18:00:00Z",
    homeTerminalTimeZone: "America/Chicago",
    dayStartMinutes: 240,
    events: [
      event("2026-08-10T00:00:00Z", 1),
      event("2026-08-18T15:00:00Z", 4)
    ]
  });
  assert.equal(status.cycleWindowStartedAt.toISOString(), "2026-08-11T09:00:00.000Z");
});

check("missing history returns unknown clocks instead of false legal availability", () => {
  const status = calculateHosStatus({ events: [], now: "2026-08-18T12:00:00Z" });
  assert.equal(status.sufficientHistory, false);
  assert.equal(status.driveRemainingMinutes, null);
  assert.equal(status.cycleRemainingMinutes, null);
});

if (process.exitCode) process.exit(process.exitCode);
process.stdout.write("\nHOS calculator tests passed. Exception profiles remain gated.\n");
