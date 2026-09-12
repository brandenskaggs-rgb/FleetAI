"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildEldOutputFile } = require("../server/eld/outputFile");
const { verifyEldOutput } = require("../server/eld/outputAuthentication");
const { appendLineDataCheck, fileDataCheck } = require("../server/eld/checksums");

const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" });
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" });

function fixture() {
  return {
    config: { eldIdentifier: "FLT001", eldRegistrationId: "TEST", usdotNumber: "1234567",
      carrierName: "Synthetic Test", multidayBasis: "US_70_8" },
    driver: { eldUsername: "synthetic", licenseNum: "TEST123", licenseState: "MO",
      firstName: "Test", lastName: "Driver" },
    vehicle: { vehicleId: "synthetic-unit", unitName: "TEST", vin: "" },
    events: [{ sequenceId: 1, sequenceEpoch: 7, eventType: 1, eventCode: 3,
      recordStatus: 1, recordOrigin: 1, occurredAt: "2026-09-10T12:00:00.000Z",
      eventDate: "260910", eventTime: "120000", eventDataCheck: "12",
      latitude: null, longitude: null, elapsedEngineHours: null, totalEngineHours: null,
      eldUsername: "synthetic", annotation: "Synthetic test record" }],
    createdAt: new Date("2026-09-10T12:01:00.000Z"),
    outputFileComment: "Synthetic test only", privateKeyPem
  };
}

function check(name, run) {
  try { run(); process.stdout.write(`PASS ${name}\n`); }
  catch (error) { process.stderr.write(`FAIL ${name}: ${error.message}\n`); process.exitCode = 1; }
}

function rewrite(content, mutate, repairChecks = true) {
  const lines = content.slice(0, -1).split("\r");
  mutate(lines);
  if (repairChecks) {
    const checks = [];
    for (let i = 0; i < lines.length - 2; i++) {
      if (lines[i].endsWith(":")) continue;
      lines[i] = appendLineDataCheck(lines[i].slice(0, lines[i].lastIndexOf(",")));
      checks.push(lines[i].split(",").at(-1));
    }
    lines[lines.length - 1] = fileDataCheck(checks);
  }
  return lines.join("\r") + "\r";
}

check("file authentication requires no internal sequence epoch or database", () => {
  const input = fixture();
  const before = buildEldOutputFile(input);
  input.events[0].sequenceEpoch = 99;
  const after = buildEldOutputFile(input);
  assert.equal(before.content, after.content);
  assert.equal(verifyEldOutput(before.content, publicKeyPem), true);
  assert.equal(verifyEldOutput(after.content, publicKeyPem), true);
});

check("modified header, events, comments and sections fail even with repaired checksums", () => {
  const { content } = buildEldOutputFile(fixture());
  const mutations = [
    lines => { lines[1] = lines[1].replace("Test", "Changed"); },
    lines => { lines[7] = lines[7].replace("Synthetic test only", "Different comment"); },
    lines => { const i = lines.indexOf("ELD Event List:") + 1; lines[i] = lines[i].replace(",3,", ",4,"); },
    lines => { lines[lines.indexOf("User List:")] = "Users:"; },
    lines => { lines.splice(lines.indexOf("ELD Event List:") + 1, 1); },
    lines => { const i = lines.indexOf("ELD Event List:") + 1; lines.splice(i, 0, lines[i]); }
  ];
  for (const mutate of mutations) {
    const edited = rewrite(content, mutate);
    assert.notEqual(edited, content);
    assert.equal(verifyEldOutput(edited, publicKeyPem), false);
  }
});

check("wrong keys, malformed signatures and malformed files are rejected", () => {
  const { content } = buildEldOutputFile(fixture());
  const wrongKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey
    .export({ type: "spki", format: "pem" });
  assert.equal(verifyEldOutput(content, wrongKey), false);
  assert.equal(verifyEldOutput(content, "not a key"), false);
  for (const signature of ["", "F200", "F100", "F1xyz", "F1" + "AB".repeat(256)]) {
    const edited = rewrite(content, lines => {
      const fields = lines[7].split(","); fields[2] = signature; lines[7] = fields.join(",");
    });
    assert.equal(verifyEldOutput(edited, publicKeyPem), false);
  }
  for (const edited of [null, "", content.replace(/\r/g, "\n"), content.replace(/\r/g, "\r\n"), content.slice(0, -1),
    content + "\r\n", content.replace("Synthetic", "Synth\u00e9tic")]) {
    assert.equal(verifyEldOutput(edited, publicKeyPem), false);
  }
  assert.equal(verifyEldOutput(rewrite(content, lines => {
    lines[lines.length - 1] = "0000";
  }, false), publicKeyPem), false);
});

check("missing or unsupported signing keys fail closed", () => {
  assert.throws(() => buildEldOutputFile({ ...fixture(), privateKeyPem: "" }),
    error => error.code === "ELD_AUTHENTICATION_KEY_MISSING");
  for (const pair of [crypto.generateKeyPairSync("rsa", { modulusLength: 1024 }),
    crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" })]) {
    assert.throws(() => buildEldOutputFile({ ...fixture(),
      privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }) }), /RSA key/);
  }
});

check("non-ASCII output is rejected rather than silently signed with lossy encoding", () => {
  const input = fixture(); input.driver.firstName = "Jos\u00e9";
  assert.throws(() => buildEldOutputFile(input), /ASCII/);
});

check("verification command reports status without printing records or key material", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fleetai-eld-auth-test-"));
  try {
    const file = path.join(directory, "synthetic-output.txt");
    const certificate = path.join(directory, "public.pem");
    const content = buildEldOutputFile(fixture()).content;
    fs.writeFileSync(file, content);
    fs.writeFileSync(certificate, publicKeyPem);
    const script = path.resolve(__dirname, "../scripts/eld-verify-output.js");
    const run = args => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    const valid = run([file, certificate]);
    assert.equal(valid.status, 0);
    assert.equal(JSON.parse(valid.stdout).authenticationValid, true);
    assert.equal(JSON.parse(valid.stdout).fmcsaValidation, "not_performed");
    assert.equal(valid.stderr, "");
    assert.equal(valid.stdout.includes("Synthetic test record"), false);
    assert.equal(fs.readFileSync(file, "utf8"), content);
    fs.writeFileSync(file, content.replace("Synthetic test record", "Altered record"));
    const invalid = run([file, certificate]);
    assert.equal(invalid.status, 1);
    assert.equal(JSON.parse(invalid.stdout).authenticationValid, false);
    assert.equal(run([]).status, 2);
    const missing = run([path.join(directory, "missing.txt"), certificate]);
    assert.equal(missing.status, 2);
    assert.equal(missing.stderr.includes(directory), false);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^fleetai-eld-auth-test-/);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

if (!process.exitCode) process.stdout.write("ELD output authentication regressions passed. Not FMCSA validation.\n");
