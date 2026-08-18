"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const requiredFiles = [
  "server/eld/constants.js",
  "server/eld/checksums.js",
  "server/eld/eldService.js",
  "server/eld/outputFile.js",
  "server/routes/eldRoutes.js",
  "docs/eld/PROVIDER_SUBMISSION_CHECKLIST.md",
  "docs/eld/TEST_PLAN.md",
  "docs/eld/MALFUNCTION_GUIDE.md",
  "docs/eld/DATA_TRANSFER_GUIDE.md",
  "docs/eld/HOS_RULE_MATRIX.md"
];

const envChecks = [
  ["FMCSA_ELD_AUTH_PRIVATE_KEY", "Provider authentication private key"],
  ["FMCSA_ELD_CLIENT_CERT", "FMCSA web-service client certificate"],
  ["FMCSA_ELD_CLIENT_KEY", "FMCSA web-service client key"],
  ["FMCSA_ELD_WEBSERVICE_URL", "FMCSA provider-portal web-service endpoint"],
  ["FMCSA_ELD_EMAIL_ADDRESS", "FMCSA provider-portal transfer email"],
  ["ELD_OFFLINE_ENGINE_COMPLETE", "On-device offline event engine"],
  ["ELD_HOS_ENGINE_VALIDATED", "Authoritative HOS engine validation"],
  ["ELD_ROADSIDE_DISPLAY_COMPLETE", "Eight-day roadside display"],
  ["ELD_TRANSFER_IMPLEMENTATION_COMPLETE", "Web-service and email transfer implementation"],
  ["ELD_INDEPENDENT_REVIEW_COMPLETE", "Independent compliance review gate"],
  ["ELD_FIELD_VALIDATION_COMPLETE", "Controlled truck field-validation gate"],
  ["ELD_FMCSA_LISTING_CONFIRMED", "Exact model/version on FMCSA registered-device list"]
];

const booleanGates = new Set([
  "ELD_OFFLINE_ENGINE_COMPLETE",
  "ELD_HOS_ENGINE_VALIDATED",
  "ELD_ROADSIDE_DISPLAY_COMPLETE",
  "ELD_TRANSFER_IMPLEMENTATION_COMPLETE",
  "ELD_INDEPENDENT_REVIEW_COMPLETE",
  "ELD_FIELD_VALIDATION_COMPLETE",
  "ELD_FMCSA_LISTING_CONFIRMED"
]);

const results = [];
for (const file of requiredFiles) {
  results.push({ name: file, ready: fs.existsSync(path.join(root, file)), type: "file" });
}
for (const [name, label] of envChecks) {
  const value = String(process.env[name] || "").trim();
  const ready = booleanGates.has(name) ? value === "true" : Boolean(value);
  results.push({ name: label, ready, type: "external" });
}

for (const result of results) {
  process.stdout.write(`${result.ready ? "PASS" : "WAIT"} ${result.name}\n`);
}

const pending = results.filter((result) => !result.ready);
process.stdout.write(`\nELD readiness: ${results.length - pending.length}/${results.length} gates complete.\n`);
if (pending.length) {
  process.stdout.write("Fleet AI must not be represented as an FMCSA-registered ELD yet.\n");
  process.exitCode = 1;
} else {
  process.stdout.write("Automated gates are complete; confirm the FMCSA listing is public before customer use.\n");
}
