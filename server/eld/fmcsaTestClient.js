"use strict";

const https = require("node:https");
const { randomUUID } = require("node:crypto");
const { XMLBuilder, XMLParser, XMLValidator } = require("fast-xml-parser");

// Pinned to the service address and actions in the downloaded FMCSA WSDL.
const ENDPOINT = "https://eldws.fmcsa.dot.gov/ELDSubmissionService.svc";
const INFRA = "http://www.fmcsa.dot.gov/schemas/FMCSA.ELD.Infrastructure";
const MODELS = "http://www.fmcsa.dot.gov/schemas/FMCSA.ELD.Models";
const SOAP = "http://www.w3.org/2003/05/soap-envelope";
const ADDRESSING = "http://www.w3.org/2005/08/addressing";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const PING_STATUSES = new Set(["Success", "InvalidRegistrationData", "ELDDecertified", "UnexpectedError", "ExpiredCertificate"]);
const VALIDATION_STATUSES = new Set(["Valid", "Error", "Warning", "Information", "NotValidated"]);

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function actionFor(operation) {
  if (!["Ping", "Submit"].includes(operation)) throw failure("FMCSA_INVALID_OPERATION");
  return `${INFRA}/IELDSubmissionService/${operation}`;
}

function identityFields(identity) {
  if (!/^[A-Z0-9]{6}$/.test(identity?.eldIdentifier || "")
      || !/^[A-Z0-9]{4}$/.test(identity?.eldRegistrationId || "")) {
    throw failure("FMCSA_INVALID_IDENTITY");
  }
  return { ELDIdentifier: identity.eldIdentifier, ELDRegistrationId: identity.eldRegistrationId };
}

function buildRequest(operation, identity, submission, messageId = `urn:uuid:${randomUUID()}`) {
  const action = actionFor(operation);
  const data = identityFields(identity);
  if (operation === "Submit") {
    if (submission?.test !== true) throw failure("FMCSA_TEST_ONLY");
    if (typeof submission.content !== "string" || !submission.content.length
        || Buffer.byteLength(submission.content) > MAX_FILE_BYTES) throw failure("FMCSA_INVALID_OUTPUT_SIZE");
    if (typeof submission.comment !== "string" || submission.comment.length > 60
        || /[\x00-\x1F]/.test(submission.comment)) throw failure("FMCSA_INVALID_COMMENT");
    if (!/^[A-Za-z_]{5}[0-9]{10}-[A-Z0-9]{9}$/.test(submission.filename || "")) throw failure("FMCSA_INVALID_FILENAME");
    Object.assign(data, { OutputFileBody: submission.content, OutputFileComment: submission.comment,
      OutputFilename: submission.filename, Test: "true", Version: "V1" });
  }
  const xml = new XMLBuilder({ ignoreAttributes: false, format: false }).build({
    "s:Envelope": { "@_xmlns:s": SOAP, "@_xmlns:a": ADDRESSING,
      "s:Header": {
        "a:Action": { "@_s:mustUnderstand": "1", "#text": action },
        "a:MessageID": messageId,
        "a:ReplyTo": { "a:Address": `${ADDRESSING}/anonymous` },
        "a:To": { "@_s:mustUnderstand": "1", "#text": ENDPOINT }
      },
      "s:Body": { [operation]: { "@_xmlns": INFRA, data } }
    }
  });
  // XML parsers normalize literal CRLF. Character references preserve exported bytes.
  return { xml: xml.replace(/\r/g, "&#13;"), action, messageId };
}

function namespaces(value, inherited = {}) {
  const ns = { ...inherited };
  for (const [key, uri] of Object.entries(value || {})) {
    if (key === "@_xmlns") ns[""] = uri;
    else if (key.startsWith("@_xmlns:")) ns[key.slice(8)] = uri;
  }
  return ns;
}

function children(parent, name, namespace) {
  const results = [];
  for (const [tag, raw] of Object.entries(parent.value || {})) {
    if (tag.startsWith("@_") || tag.startsWith("#") || tag.startsWith("?")) continue;
    const split = tag.split(":");
    if (split.at(-1) !== name) continue;
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      const ns = namespaces(typeof value === "object" ? value : {}, parent.ns);
      if (ns[split.length === 2 ? split[0] : ""] !== namespace) throw failure("FMCSA_INVALID_RESPONSE_NAMESPACE");
      results.push({ value, ns });
    }
  }
  return results;
}

function child(parent, name, namespace, required = true) {
  const matches = children(parent, name, namespace);
  if (matches.length > 1 || (required && matches.length !== 1)) throw failure("FMCSA_INVALID_RESPONSE_SHAPE");
  return matches[0];
}

function text(parent, name, namespace, required = true) {
  const found = child(parent, name, namespace, required);
  if (!found) return "";
  const value = typeof found.value === "object" ? found.value["#text"] : found.value;
  if (typeof value !== "string") {
    if (!required && value === undefined) return "";
    throw failure("FMCSA_INVALID_RESPONSE_VALUE");
  }
  return value;
}

function count(parent, name, namespace) {
  const value = text(parent, name, namespace);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw failure("FMCSA_INVALID_RESPONSE_COUNT");
  return Number(value);
}

function parseResponse(xml, operation, messageId) {
  actionFor(operation);
  if (typeof xml !== "string" || Buffer.byteLength(xml) > MAX_RESPONSE_BYTES
      || /<!\s*(?:DOCTYPE|ENTITY)/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw failure("FMCSA_INVALID_RESPONSE_XML");
  }
  const doc = new XMLParser({ ignoreAttributes: false, parseTagValue: false, htmlEntities: true,
    parseAttributeValue: false, trimValues: false }).parse(xml);
  const envelope = child({ value: doc, ns: {} }, "Envelope", SOAP);
  const header = child(envelope, "Header", SOAP, false);
  if (header) {
    const relatesTo = text(header, "RelatesTo", ADDRESSING, false);
    if (relatesTo && relatesTo !== messageId) throw failure("FMCSA_RESPONSE_CORRELATION_MISMATCH");
  }
  const body = child(envelope, "Body", SOAP);
  if (child(body, "Fault", SOAP, false)) throw failure("FMCSA_SOAP_FAULT");
  const response = child(body, `${operation}Response`, INFRA);
  const result = child(response, `${operation}Result`, INFRA);
  const status = text(result, "Status", INFRA);
  if (operation === "Ping") {
    if (!PING_STATUSES.has(status)) throw failure("FMCSA_UNKNOWN_STATUS");
    return { operation, status, success: status === "Success" };
  }
  if (!VALIDATION_STATUSES.has(status)) throw failure("FMCSA_UNKNOWN_STATUS");
  const submissionId = text(result, "SubmissionId", INFRA);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(submissionId)) throw failure("FMCSA_INVALID_SUBMISSION_ID");
  const errors = child(result, "Errors", INFRA, false);
  const messages = errors ? children(errors, "ValidationError", MODELS).map(item => {
    const severity = text(item, "ErrorType", MODELS);
    if (!VALIDATION_STATUSES.has(severity)) throw failure("FMCSA_UNKNOWN_STATUS");
    return { severity, line: count(item, "Line", MODELS), start: count(item, "Start", MODELS),
      end: count(item, "End", MODELS), message: text(item, "Message", MODELS).slice(0, 1000) };
  }) : [];
  // The WSDL's ErrorCount counts ALL messages, including informational notices.
  const reportedMessageCount = count(result, "ErrorCount", INFRA);
  if (reportedMessageCount !== messages.length) throw failure("FMCSA_RESPONSE_MESSAGE_COUNT_MISMATCH");
  const validationErrorCount = messages.filter(item => item.severity === "Error").length;
  const warningCount = messages.filter(item => item.severity === "Warning").length;
  // HTTP 200 is not validation success; preserve warnings and errors from the service.
  return { operation, test: true, status, submissionId, reportedMessageCount, validationErrorCount, warningCount, messages,
    valid: ["Valid", "Information"].includes(status) && validationErrorCount === 0 && warningCount === 0 };
}

function postSoap(request, credentials, timeoutMs = 20000) {
  const hasPfx = Buffer.isBuffer(credentials?.pfx) && credentials.pfx.length > 0;
  const hasPem = typeof credentials?.cert === "string" && credentials.cert.includes("-----BEGIN CERTIFICATE-----")
    && typeof credentials?.key === "string" && credentials.key.includes("PRIVATE KEY-----");
  if (hasPfx === hasPem) throw failure("FMCSA_TEST_CERTIFICATE_REQUIRED");
  const tlsCredentials = hasPfx ? { pfx: credentials.pfx, passphrase: credentials.passphrase || "" }
    : { cert: credentials.cert, key: credentials.key };
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw failure("FMCSA_INVALID_TIMEOUT");
  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    let req;
    try {
      req = https.request(ENDPOINT, {
        method: "POST", ...tlsCredentials,
        minVersion: "TLSv1.2", rejectUnauthorized: true,
        headers: { "Content-Type": `application/soap+xml; charset=utf-8; action="${request.action}"`,
          "Content-Length": Buffer.byteLength(request.xml), "Accept": "application/soap+xml" }
      }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400) {
          res.resume(); done(failure("FMCSA_REDIRECT_REJECTED")); return;
        }
        let size = 0;
        const chunks = [];
        res.on("data", chunk => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) { done(failure("FMCSA_RESPONSE_TOO_LARGE")); res.destroy(); return; }
          chunks.push(chunk);
        });
        res.on("error", () => done(failure("FMCSA_RESPONSE_INTERRUPTED")));
        res.on("aborted", () => done(failure("FMCSA_RESPONSE_INTERRUPTED")));
        res.on("end", () => {
          if (res.statusCode !== 200) { done(failure(`FMCSA_HTTP_${res.statusCode}`)); return; }
          if (!/^application\/soap\+xml(?:\s*;|$)/i.test(res.headers["content-type"] || "")) {
            done(failure("FMCSA_INVALID_CONTENT_TYPE")); return;
          }
          done(null, Buffer.concat(chunks).toString("utf8"));
        });
      });
      timer = setTimeout(() => { done(failure("FMCSA_TIMEOUT")); req.destroy(); }, timeoutMs);
      req.on("error", () => done(failure("FMCSA_TLS_OR_NETWORK_ERROR")));
      req.end(request.xml);
    } catch { if (req) req.destroy(); done(failure("FMCSA_TLS_CONFIGURATION_ERROR")); }
  });
}

async function runTestRequest(operation, identity, credentials, submission) {
  const request = buildRequest(operation, identity, submission);
  const xml = await postSoap(request, credentials);
  return parseResponse(xml, operation, request.messageId);
}

module.exports = { ENDPOINT, INFRA, MODELS, SOAP, ADDRESSING, MAX_RESPONSE_BYTES,
  buildRequest, parseResponse, postSoap, runTestRequest };
