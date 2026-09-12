"use strict";

const crypto = require("crypto");
const { appendLineDataCheck, lineDataCheck, fileDataCheck } = require("./checksums");

const AUTHENTICATION_SCHEME = "FLEETAI-ELD-RSA-SHA256-V1";
const SIGNATURE_PREFIX = "F1";
const IDENTITY_LINE = 7;
const SECTIONS = [
  "ELD File Header Segment:", "User List:", "CMV List:", "ELD Event List:",
  "ELD Event Annotations or Comments:", "Driver's Certification/Recertification Actions:",
  "Malfunctions and Data Diagnostic Events:", "ELD Login/Logout Report:",
  "CMV Engine Power-Up and Shut Down Activity:", "Unidentified Driver Profile Records:",
  "End of File:"
];

function parseOutput(content) {
  if (typeof content !== "string" || !content.endsWith("\r")) {
    throw new Error("ELD output must use CR with a final terminator");
  }
  const lines = content.slice(0, -1).split("\r");
  if (lines.some(line => !/^[\x20-\x7E]+$/.test(line))) {
    throw new Error("ELD output must contain printable ASCII lines");
  }
  const sections = lines.filter(line => line.endsWith(":"));
  if (JSON.stringify(sections) !== JSON.stringify(SECTIONS)
      || lines[0] !== SECTIONS[0] || lines[8] !== SECTIONS[1]
      || lines.at(-2) !== "End of File:") {
    throw new Error("Unexpected ELD output section layout");
  }
  const checks = [];
  for (const line of lines.slice(0, -2)) {
    if (line.endsWith(":")) continue;
    const index = line.lastIndexOf(",");
    if (index < 0 || line.slice(index + 1) !== lineDataCheck(line.slice(0, index))) {
      throw new Error("ELD line data check mismatch");
    }
    checks.push(line.slice(index + 1));
  }
  if (lines.at(-1) !== fileDataCheck(checks)) throw new Error("ELD file data check mismatch");
  const identity = lines[IDENTITY_LINE].split(",");
  if (identity.length !== 5) throw new Error("Unexpected ELD identity line");
  return { lines, identity };
}

function canonicalPayload(lines, identity) {
  const canonical = lines.slice(0, -1);
  // Exclude only the signature and its two dependent checksums to avoid circular signing.
  canonical[IDENTITY_LINE] = [identity[0], identity[1], "", identity[3]].join(",");
  return Buffer.from(`${AUTHENTICATION_SCHEME}\r${canonical.join("\r")}\r`, "ascii");
}

function requireRsaKey(key) {
  if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails?.modulusLength < 2048) {
    throw new Error("ELD output signing requires an RSA key of at least 2048 bits");
  }
  return { key, padding: crypto.constants.RSA_PKCS1_PADDING };
}

function signEldOutput(content, privateKeyPem) {
  if (!privateKeyPem) {
    const error = new Error("FMCSA ELD authentication private key is not configured");
    error.code = "ELD_AUTHENTICATION_KEY_MISSING";
    error.statusCode = 503;
    throw error;
  }
  const { lines, identity } = parseOutput(content);
  const key = requireRsaKey(crypto.createPrivateKey(privateKeyPem));
  const signature = crypto.sign("sha256", canonicalPayload(lines, identity), key);
  identity[2] = SIGNATURE_PREFIX + signature.toString("hex").toUpperCase();
  lines[IDENTITY_LINE] = appendLineDataCheck(identity.slice(0, -1).join(","));
  const checks = lines.slice(0, -2).filter(line => !line.endsWith(":"))
    .map(line => line.slice(line.lastIndexOf(",") + 1));
  lines[lines.length - 1] = fileDataCheck(checks);
  return {
    content: `${lines.join("\r")}\r`,
    fileDataCheck: lines.at(-1),
    authenticationValue: identity[2],
    authenticationScheme: AUTHENTICATION_SCHEME
  };
}

function verifyEldOutput(content, publicKeyPem) {
  try {
    const { lines, identity } = parseOutput(content);
    if (!/^F1(?:[0-9A-F]{2})+$/.test(identity[2])) return false;
    const key = requireRsaKey(crypto.createPublicKey(publicKeyPem));
    const signature = Buffer.from(identity[2].slice(SIGNATURE_PREFIX.length), "hex");
    if (signature.length !== Math.ceil(key.key.asymmetricKeyDetails.modulusLength / 8)) return false;
    return crypto.verify("sha256", canonicalPayload(lines, identity), key, signature);
  } catch {
    return false;
  }
}

module.exports = { AUTHENTICATION_SCHEME, signEldOutput, verifyEldOutput };
