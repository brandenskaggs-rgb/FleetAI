"use strict";

const assert = require("assert");
const path = require("path");
const { spawnSync } = require("child_process");

const script = path.join(__dirname, "..", "scripts", "eld-readiness.js");
const credentialNames = [
  "FMCSA_ELD_AUTH_PRIVATE_KEY",
  "FMCSA_ELD_CLIENT_CERT",
  "FMCSA_ELD_CLIENT_KEY",
  "FMCSA_ELD_WEBSERVICE_URL",
  "FMCSA_ELD_EMAIL_ADDRESS"
];
const booleanNames = [
  "ELD_OFFLINE_ENGINE_COMPLETE",
  "ELD_HOS_ENGINE_VALIDATED",
  "ELD_ROADSIDE_DISPLAY_COMPLETE",
  "ELD_TRANSFER_IMPLEMENTATION_COMPLETE",
  "ELD_INDEPENDENT_REVIEW_COMPLETE",
  "ELD_FIELD_VALIDATION_COMPLETE",
  "ELD_FMCSA_LISTING_CONFIRMED"
];

function run(overrides) {
  const env = { ...process.env };
  credentialNames.forEach((name) => { env[name] = ""; });
  booleanNames.forEach((name) => { env[name] = "false"; });
  return spawnSync(process.execPath, [script], {
    cwd: path.join(__dirname, ".."),
    env: { ...env, ...overrides },
    encoding: "utf8"
  });
}

const falseResult = run({});
assert.equal(falseResult.status, 1);
assert.match(falseResult.stdout, /WAIT Authoritative HOS engine validation/);
assert.match(falseResult.stdout, /WAIT Exact model\/version on FMCSA registered-device list/);

const trueValues = Object.fromEntries([
  ...credentialNames.map((name) => [name, "test-value"]),
  ...booleanNames.map((name) => [name, "true"])
]);
const trueResult = run(trueValues);
assert.equal(trueResult.status, 0, trueResult.stdout + trueResult.stderr);
assert.match(trueResult.stdout, /ELD readiness: 22\/22 gates complete/);

process.stdout.write("ELD readiness gate tests passed.\n");
