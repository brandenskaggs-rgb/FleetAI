"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const https = require("node:https");
const { XMLParser } = require("fast-xml-parser");
const client = require("../server/eld/fmcsaTestClient");
const { ENDPOINT, INFRA, MODELS, SOAP, ADDRESSING } = client;
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false, htmlEntities: true });
const identity = { eldIdentifier: "FLT001", eldRegistrationId: "TEST" };
const messageId = "urn:uuid:00000000-0000-4000-8000-000000000001";
const submission = { test: true, filename: "Drive2311091126-000000000", comment: "A & B <test>",
  content: "Synthetic & <test>\r\nSecond line\r\n" };

function envelope(body, relatesTo = messageId) {
  return `<s:Envelope xmlns:s="${SOAP}" xmlns:a="${ADDRESSING}"><s:Header><a:RelatesTo>${relatesTo}</a:RelatesTo></s:Header><s:Body>${body}</s:Body></s:Envelope>`;
}
function ping(status = "Success") {
  return envelope(`<PingResponse xmlns="${INFRA}"><PingResult><Status>${status}</Status></PingResult></PingResponse>`);
}
function submit(status = "Warning", errors = "1", messageType = "Information") {
  return envelope(`<SubmitResponse xmlns="${INFRA}"><SubmitResult><ErrorCount>${errors}</ErrorCount><Errors xmlns:b="${MODELS}"><b:ValidationError><b:Detail>&lt;b&gt;not executable&lt;/b&gt;</b:Detail><b:End>1</b:End><b:ErrorType>${messageType}</b:ErrorType><b:Line>0</b:Line><b:Message>Test certificate only</b:Message><b:Start>0</b:Start></b:ValidationError></Errors><Status>${status}</Status><SubmissionId>11111111-1111-4111-8111-111111111111</SubmissionId></SubmitResult></SubmitResponse>`);
}

async function check(name, fn) {
  try { await fn(); process.stdout.write(`PASS ${name}\n`); }
  catch (error) { process.stderr.write(`FAIL ${name}: ${error.message}\n`); process.exitCode = 1; }
}

async function main() {
  await check("request contract matches downloaded WSDL operation, fields and endpoint", () => {
    const wsdl = parser.parse(fs.readFileSync(path.join(__dirname, "../docs/eld/contracts/ELDSubmissionService.wsdl"), "utf8"))["wsdl:definitions"];
    assert.equal(wsdl["wsdl:service"]["wsdl:port"]["soap12:address"]["@_location"], ENDPOINT);
    const operations = wsdl["wsdl:portType"]["wsdl:operation"];
    for (const operation of ["Ping", "Submit"]) {
      const request = client.buildRequest(operation, identity, submission, messageId);
      assert.equal(request.action, operations.find(item => item["@_name"] === operation)["wsdl:input"]["@_wsaw:Action"]);
      const body = parser.parse(request.xml)["s:Envelope"];
      assert.equal(body["@_xmlns:s"], SOAP);
      assert.equal(body["s:Header"]["a:To"]["#text"], ENDPOINT);
      const data = body["s:Body"][operation].data;
      const schema = wsdl["wsdl:types"]["xs:schema"].find(item => item["@_targetNamespace"] === INFRA);
      const type = schema["xs:complexType"].find(item => item["@_name"] === (operation === "Submit" ? "ELDSubmission" : "DiagnosticRequest"));
      assert.deepEqual(Object.keys(data), type["xs:sequence"]["xs:element"].map(item => item["@_name"]));
      if (operation === "Submit") {
        assert.equal(data.Test, "true"); assert.equal(data.Version, "V1");
        assert.equal(data.OutputFileBody, submission.content);
        assert.equal(data.OutputFileComment, submission.comment);
        assert.ok(request.xml.includes("&#13;"));
      }
    }
  });
  await check("production submission and malformed inputs fail closed", () => {
    for (const test of [undefined, false, "true", 1]) {
      assert.throws(() => client.buildRequest("Submit", identity, { ...submission, test }), /FMCSA_TEST_ONLY/);
    }
    assert.throws(() => client.buildRequest("Other", identity), /INVALID_OPERATION/);
    assert.throws(() => client.buildRequest("Ping", { ...identity, eldIdentifier: "<bad>" }), /INVALID_IDENTITY/);
    assert.throws(() => client.buildRequest("Submit", identity, { ...submission, comment: "x".repeat(61) }), /INVALID_COMMENT/);
    assert.throws(() => client.buildRequest("Submit", identity, { ...submission, filename: "../../file" }), /INVALID_FILENAME/);
  });
  await check("response parsing distinguishes validation success, warnings, and errors", () => {
    assert.equal(client.parseResponse(ping(), "Ping", messageId).success, true);
    assert.equal(client.parseResponse(ping("ExpiredCertificate"), "Ping", messageId).success, false);
    const warning = client.parseResponse(submit(), "Submit", messageId);
    assert.equal(warning.valid, false); assert.equal(warning.status, "Warning");
    assert.equal(warning.messages[0].severity, "Information");
    assert.equal(client.parseResponse(submit("Valid"), "Submit", messageId).valid, true);
    const information = client.parseResponse(submit("Information"), "Submit", messageId);
    assert.equal(information.valid, true);
    assert.equal(information.reportedMessageCount, 1);
    assert.equal(information.validationErrorCount, 0);
    assert.equal(information.warningCount, 0);
    assert.equal(client.parseResponse(submit("Valid", "1", "Error"), "Submit", messageId).valid, false);
    assert.equal(client.parseResponse(submit("NotValidated"), "Submit", messageId).valid, false);
    assert.throws(() => client.parseResponse(submit("Information", "2"), "Submit", messageId), /MESSAGE_COUNT_MISMATCH/);
  });
  await check("malformed, spoofed, mismatched, entity-bearing and fault responses fail", () => {
    for (const xml of ["<invalid>", "<!DOCTYPE x [<!ENTITY leak SYSTEM 'file:///etc/passwd'>]>" + ping(),
      ping().replace(SOAP, "urn:wrong"), ping().replace(INFRA, "urn:wrong"),
      ping().replace(messageId, "urn:uuid:wrong"), ping().replace("</Status>", "</Status><Status>Success</Status>"),
      ping("Unknown"), "x".repeat(client.MAX_RESPONSE_BYTES + 1),
      envelope("<s:Fault><s:Code><s:Value>s:Sender</s:Value></s:Code></s:Fault>")]) {
      assert.throws(() => client.parseResponse(xml, "Ping", messageId), /FMCSA_/);
    }
  });
  await check("HTTPS transport enforces TLS validation, fixed destination, and no redirect/retry", async () => {
    const original = https.request;
    try {
      let calls = 0;
      https.request = (url, options, callback) => {
        calls++; assert.equal(url, ENDPOINT); assert.equal(options.rejectUnauthorized, true);
        assert.equal(options.minVersion, "TLSv1.2"); assert.equal(options.method, "POST");
        const request = new EventEmitter();
        request.destroy = () => {};
        request.end = () => process.nextTick(() => {
          const response = new EventEmitter(); response.statusCode = 302;
          response.resume = () => {}; response.headers = { location: "https://untrusted.invalid/" };
          callback(response);
        });
        return request;
      };
      await assert.rejects(client.postSoap(client.buildRequest("Ping", identity), { pfx: Buffer.from("fake") }), /REDIRECT_REJECTED/);
      assert.equal(calls, 1);
    } finally { https.request = original; }
  });
  await check("transport has a deadline and does not expose raw TLS errors", async () => {
    const original = https.request;
    try {
      let destroyed = false;
      https.request = () => {
        const request = new EventEmitter(); request.destroy = () => { destroyed = true; };
        request.end = () => {}; return request;
      };
      await assert.rejects(client.postSoap(client.buildRequest("Ping", identity), { pfx: Buffer.from("fake") }, 5), /FMCSA_TIMEOUT/);
      assert.equal(destroyed, true);
      https.request = () => { throw new Error("secret path and passphrase"); };
      await assert.rejects(client.postSoap(client.buildRequest("Ping", identity), { pfx: Buffer.from("fake") }),
        error => error.message === "FMCSA_TLS_CONFIGURATION_ERROR");
    } finally { https.request = original; }
  });
}

main().catch(() => { process.stderr.write("Unexpected FMCSA test failure\n"); process.exitCode = 1; });
