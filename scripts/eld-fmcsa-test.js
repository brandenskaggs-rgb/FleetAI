"use strict";

// Local diagnostics only. No environment secrets, database records or production routes.
const { runTestRequest } = require("../server/eld/fmcsaTestClient");
const fs = require("node:fs");
const path = require("node:path");
const { syntheticSubmission } = require("./lib/eld-synthetic-submission");

async function main() {
  const mode = process.argv.slice(2).join(" ");
  if (!["--ping", "--submit-synthetic"].includes(mode)) throw new Error("Select a test mode");
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 64000) throw new Error("Input too large");
    chunks.push(chunk);
  }
  const config = JSON.parse(Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, ""));
  if (config.test !== true) throw new Error("Test identity required");
  const identity = {
    eldIdentifier: config.eldIdentifier, eldRegistrationId: config.eldRegistrationId
  };
  const operation = mode === "--ping" ? "Ping" : "Submit";
  const submission = operation === "Submit" ? syntheticSubmission(identity, config.key) : undefined;
  const result = await runTestRequest(operation, identity,
    config.pfxBase64 ? { pfx: Buffer.from(config.pfxBase64, "base64"), passphrase: config.passphrase || "" }
      : { cert: config.cert, key: config.key }, submission);
  const report = { ...result, testedAt: new Date().toISOString(), evidenceSource: "synthetic_test",
    registrationSubmitted: false, customerRecordsUsed: false };
  const directory = path.resolve(__dirname, "../artifacts/eld");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `fmcsa-${operation.toLowerCase()}-${Date.now()}.json`), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report) + "\n");
  process.exitCode = (operation === "Ping" ? result.success : result.valid) ? 0 : 1;
}

main().catch(error => {
  const code = /^FMCSA_[A-Z_0-9]+$/.test(error.code || "") ? error.code : "FMCSA_TEST_INPUT_ERROR";
  process.stderr.write(JSON.stringify({ ok: false, code, registrationSubmitted: false }) + "\n");
  process.exitCode = 1;
});
