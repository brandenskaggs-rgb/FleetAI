"use strict";

const fs = require("node:fs");
const { AUTHENTICATION_SCHEME, verifyEldOutput } = require("../server/eld/outputAuthentication");

const args = process.argv.slice(2);
if (args.length !== 2 || args.some(arg => arg.startsWith("-"))) {
  process.stderr.write("Usage: node scripts/eld-verify-output.js <output-file> <public-key-or-certificate.pem>\n");
  process.exitCode = 2;
} else {
  try {
    const content = fs.readFileSync(args[0], "utf8");
    const publicKeyPem = fs.readFileSync(args[1], "utf8");
    if (/-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(publicKeyPem)) {
      throw new Error("Public key required");
    }
    const valid = verifyEldOutput(content, publicKeyPem);
    process.stdout.write(JSON.stringify({
      scheme: AUTHENTICATION_SCHEME,
      authenticationValid: valid,
      fmcsaValidation: "not_performed"
    }) + "\n");
    process.exitCode = valid ? 0 : 1;
  } catch {
    // Paths, key material and exported driver data must not appear in diagnostics.
    process.stderr.write("Verification failed: provide a readable output file and public PEM key/certificate.\n");
    process.exitCode = 2;
  }
}
