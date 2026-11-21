const { PDFDocument } = require("pdfkit");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { XMLParser } = require("fast-xml-parser");

const TEMPLATE_VERSION = "fleet-evidence-v2";
const MAX_PDF_BYTES = 4 * 1024 * 1024;
const logo = new XMLParser({ ignoreAttributes: false }).parse(fs.readFileSync(
  path.join(__dirname, "../../assets/brand/fleet-ai-mark.svg"), "utf8"
)).svg.path["@_d"];
const text = value => value == null || value === "" ? "Not recorded" :
  String(value).replace(/\*\*([^*]+)\*\*/g, "$1").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
const date = value => value && Number.isFinite(new Date(value).getTime())
  ? new Date(value).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC") : "Not recorded";

// Fixed sections/columns, not LLM-generated layout. Only saved evidence enters this renderer.
async function renderReportPdf(artifact) {
  const doc = new PDFDocument({ size: "LETTER", margins: { top: 76, bottom: 58, left: 46, right: 46 },
    bufferPages: true, info: { Title: text(artifact.title), Author: "Fleet AI", Subject: TEMPLATE_VERSION } });
  const chunks = [];
  let bytes = 0;
  const result = new Promise((resolve, reject) => {
    doc.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > MAX_PDF_BYTES) doc.destroy(new Error("report_pdf_size_limit"));
      else chunks.push(chunk);
    });
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const content = artifact.content || {}, source = content.sources || {};
  const width = 520, bottom = 724;
  function page() {
    if (doc.bufferedPageRange().count >= 80) throw new Error("report_page_limit");
    doc.addPage();
  }
  function room(height) { if (doc.y + height > bottom) page(); }
  function paragraph(value, size = 10, color = "#39464a") {
    doc.font("Helvetica").fontSize(size).fillColor(color).text(text(value), 46, doc.y, { width, lineGap: 4 });
    doc.moveDown(0.6);
  }
  function heading(label) {
    room(85); doc.moveDown(0.8);
    doc.font("Helvetica-Bold").fontSize(14).fillColor("#172225").text(label, 46, doc.y, { width });
    doc.moveDown(0.6);
  }
  function table(columns, rows) {
    if (!rows?.length) { paragraph("No records were available in this report's retrieved evidence."); return; }
    const colWidth = width / columns.length;
    function header() {
      room(50); const y = doc.y;
      doc.rect(46, y, width, 25).fill("#edf1f2");
      columns.forEach(([label], i) => doc.font("Helvetica-Bold").fontSize(9).fillColor("#39464a")
        .text(label, 53 + i * colWidth, y + 8, { width: colWidth - 14, lineBreak: false }));
      doc.y = y + 29;
    }
    header();
    for (const row of rows.slice(0, 100)) {
      const values = columns.map(([, read]) => text(read(row)));
      // Table cells stay brief; full descriptions live below the table.
      const cells = values.map(value => value.length > 180 ? `${value.slice(0, 177)}...` : value);
      doc.font("Helvetica").fontSize(9);
      const height = Math.max(28, ...cells.map(value => doc.heightOfString(value, { width: colWidth - 14, lineGap: 2 }) + 16));
      if (doc.y + height > bottom) { page(); header(); }
      const y = doc.y;
      cells.forEach((value, i) => doc.font("Helvetica").fontSize(9).fillColor("#172225")
        .text(value, 53 + i * colWidth, y + 6, { width: colWidth - 14, lineGap: 2 }));
      doc.moveTo(46, y + height).lineTo(566, y + height).strokeColor("#e4e9ea").lineWidth(0.5).stroke();
      doc.y = y + height + 2;
    }
    if (rows.length > 100) paragraph(`Showing 100 of ${rows.length} retrieved records.`);
    doc.moveDown(0.6);
  }
  function sensorTable(coverage) {
    heading("Recorded sensor values");
    paragraph(`${coverage.reviewed ?? 0} telemetry rows reviewed${Number.isFinite(coverage.retained) ? " out of "+coverage.retained+" stored for this vehicle" : ""}. ${coverage.from && coverage.to ? "Window: "+date(coverage.from)+" to "+date(coverage.to)+"." : "No dated readings in this selection."}${coverage.truncated ? " Limited to the first 1,000 rows." : ""}`);
    paragraph("Latest is the last recorded value in this window, not a live reading. Low and high can come from different times. The row count is the number of records containing that signal.",9);
    const measured = source.signalSummary.filter(r=>r.count>0);
    if (measured.length) table([["Signal / unit",r=>r.label+(r.unit?" ("+r.unit+")":"")],["Latest",r=>r.latest],["Low to high",r=>r.min+" to "+r.max],["Rows",r=>r.count],["Latest row (UTC)",r=>date(r.recordedAt).replace(" UTC","")]], measured);
    else paragraph("No measured values were available for the signals listed in this report.");
    const missing = source.signalSummary.filter(r=>!r.count);
    if (missing.length) { heading("Not measured in this window"); paragraph(missing.map(r=>r.label).join(", ")+". Missing readings are not zeros or evidence these systems passed."); }
  }
  try {
    doc.font("Helvetica-Bold").fontSize(26).fillColor("#172225").text(text(artifact.title), 46, doc.y, { width });
    doc.moveDown(0.5);
    paragraph(`Generated: ${date(artifact.createdAt || source.generatedAt)}\nScope: ${content.scope?.vehicleId || content.scope?.organization || source.organization?.name || "Saved diagnostic evidence"}\nTemplate: ${TEMPLATE_VERSION}`, 9);
    if (["Maintenance evidence","mechanic"].includes(artifact.type) && source.signalSummary) {
      const coverage = source.sampleCoverage || {};
      const scans = source.inspections?.diagnosticScans || [];
      const latestScan = scans[0];
      heading("Reason for inspection");
      if (artifact.type === "Maintenance evidence") paragraph(content.summary);
      else if (latestScan) paragraph(`Most recent fault read: ${date(latestScan.scannedAt)}. ${latestScan.diagnosticStatus?.message || "See recorded codes below."}`);
      else paragraph("No fault scan was retrieved. That does not establish that the vehicle has no faults.");
      const codeRows = scans.flatMap(scan => (scan.codes || []).map(item => ({
        ...(typeof item === "string" ? { code:item } : item), scannedAt:scan.scannedAt
      })));
      const seen = new Set();
      const recentCodes = codeRows.filter(row => {
        const key = JSON.stringify([row.code,row.codeStatus]);
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });
      if (recentCodes.length) table([["Fault code",r=>r.code],["Status at read",r=>r.codeStatus||"Reported"],["Meaning",r=>r.parameter||r.description],["Last reported",r=>date(r.scannedAt)]],recentCodes);
      if (source.predictions?.length && !scans.length) paragraph(`Model evidence recorded: ${date(source.predictions[0].createdAt)}. A model warning is not a confirmed failure.`);
      sensorTable(coverage);
      heading("What to verify");
      paragraph("Compare the recorded codes and symptoms with a current scan and the vehicle's freeze-frame. A stored code identifies a condition to investigate, not a part to replace. Permanent codes can remain after repair.");
      for (const limit of source.limitations || []) paragraph(limit,9);
    } else {
    heading("01 / Summary");
    paragraph(content.summary || "This report contains the available saved fleet records. Missing information is marked, not inferred.", 11);
    if (source.signalSummary && ["fleet","drive","maintenance","risk"].includes(artifact.type)) sensorTable(source.sampleCoverage || {});
    heading("02 / Evidence coverage");
    paragraph(`Report type: ${artifact.type || "fleet"}. ${source.lookbackDays ? `Telemetry lookback: ${source.lookbackDays} days, subject to query limits.` : "Point-in-time evidence snapshot."} This is not a complete lifetime history or a new ECU scan. Empty sections mean no retrieved evidence, not that the vehicle has no faults.`);
    if (source.recordCounts) paragraph(`Retrieved context counts (not lifetime totals; personnel counts can be fleet-wide): ${Object.entries(source.recordCounts).map(([k, v]) => `${k}: ${v}`).join("; ")}`, 9);
    table([["Unit", r => r.unitName || r.vehicleId], ["Year", r => r.year], ["Make / model", r => [r.make, r.model].filter(Boolean).join(" ")], ["Class", r => r.type]], source.assets);
    heading("03 / Health and model evidence");
    table([["Vehicle", r => r.vehicleId], ["Health score", r => r.healthScore], ["Learning stage", r => r.confidenceStage], ["Recorded", r => date(r.updatedAt)]], source.vehicleHealth);
    const predictions = source.predictions || (source.modelEvidence ? [source.modelEvidence] : []);
    table([["Model version", r => r.modelVersion], ["Source", r => r.source], ["Confidence", r => r.confidence], ["Recorded", r => date(r.createdAt)]], predictions);
    paragraph("Model scores are decision support, not confirmed failures or a guarantee of remaining life. Synthetic validation is not proven field accuracy. Confidence values are not evidence of calibrated failure probabilities.", 9);
    heading("04 / Faults and maintenance priorities");
    if (source.faultCodes) paragraph(`Fault read: ${source.faultCodes.status}; captured ${date(source.faultCodes.capturedAt)}. ${source.faultCodes.coverage || "Only reported modules are represented; TPMS/ABS coverage is not established."}`);
    const scans = source.inspections?.diagnosticScans || [];
    table([["Vehicle", r => r.vehicleId], ["Read completeness", r => r.diagnosticStatus?.completeness || "Legacy read"], ["Check-engine command", r => r.diagnosticStatus?.milOn == null ? "Not read" : r.diagnosticStatus.milOn ? "On at read" : "Off at read"], ["Read at", r => date(r.scannedAt)]], scans);
    for (const scan of scans.slice(0, 10)) if (scan.diagnosticStatus?.message) paragraph(`${text(scan.vehicleId)}: ${scan.diagnosticStatus.message}`, 9);
    const faults = scans.flatMap(scan => (scan.codes || []).map(code => ({ ...code, vehicleId: scan.vehicleId, scannedAt: scan.scannedAt })));
    faults.push(...(source.faultCodes?.codes || []));
    table([["Vehicle", r => r.vehicleId || source.vehicleId], ["Code / status", r => `${r.code || "Unknown"}${r.codeStatus ? ` (${r.codeStatus})` : ""}`], ["Severity", r => r.severity], ["Read at", r => date(r.scannedAt || source.faultCodes?.capturedAt)]], faults);
    for (const fault of faults.slice(0, 30)) paragraph(`${text(fault.code)}: ${text(fault.parameter || fault.description)}`, 9);
    if (faults.some(fault => fault.codeStatus === "permanent")) paragraph("Permanent codes can remain after a repair. Their presence alone does not establish an active fault.", 9);
    table([["Vehicle", r => r.vehicleId], ["Alert", r => r.type], ["Severity", r => r.severity], ["Recorded", r => date(r.createdAt)]], source.alerts);
    for (const alert of (source.alerts || []).slice(0, 30)) paragraph(`${text(alert.vehicleId)} / ${text(alert.type)}: ${text(alert.explanation)}`, 9);
    heading("05 / Activity and service records");
    const service = [...(source.maintenance || []), ...(source.workOrders || [])];
    table([["Vehicle", r => r.vehicleId], ["Service", r => r.serviceType || r.title], ["Status", r => r.status], ["Date", r => date(r.performedAt || r.dueDate)]], service);
    for (const record of service.slice(0, 30)) if (record.description) paragraph(`${text(record.vehicleId)}: ${record.description}`, 9);
    table([["Vehicle", r => r.vehicleId], ["Session started", r => date(r.startedAt)], ["Minutes observed", r => r.durationMinutes], ["Samples retrieved", r => r.sampleCount]], source.driveLogs);
    for (const log of (source.driveLogs || []).slice(0, 24)) {
      const coolant = Number.isFinite(log.maximumCoolantTempC) ? `${(log.maximumCoolantTempC * 9 / 5 + 32).toFixed(1)} F (${log.maximumCoolantTempC} C)` : "not recorded";
      paragraph(`${text(log.vehicleId)} / ${date(log.startedAt)}: maximum coolant ${coolant}; typical running voltage ${text(log.typicalRunningVoltage)} V. Session and distance estimates are based on retrieved samples, not a certified trip log.`, 9);
    }
    table([["Vehicle", r => r.vehicleId], ["Gallons (estimated)", r => r.gallonsEstimated], ["Status", r => r.status], ["Recorded", r => date(r.startedAt)]], source.fuel);
    if (source.compliance) table([["Vehicle", r => r.vehicleId], ["Driver", r => r.driverId], ["Duty status", r => r.dutyStatus], ["Occurred", r => date(r.occurredAt)]], source.compliance.dutyEvents);
    if (source.readings) {
      heading("06 / Sensor evidence");
      table([["Sensor", r => r.label || r.signal], ["Value / unit", r => r.value == null ? "Not reported" : `${r.value} ${r.unit || ""}`], ["Freshness", r => r.state], ["Recorded", r => date(r.recordedAt)]], source.readings);
    }
    heading("Limitations and next steps");
    paragraph("Review reported faults and symptoms with a qualified technician. An illuminated warning light should not be dismissed because this report has no codes. Generic OBD engine/emissions reads do not establish TPMS, ABS, or complete manufacturer-module coverage. No codes are cleared and no vehicle settings are changed.");
    for (const limit of source.limitations || []) paragraph(limit, 9);
    paragraph("Evidence is limited to the records retrieved when this report was created. The saved report does not update as new telemetry arrives. Request a new report for updated evidence.", 9);
    }
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      doc.save().translate(46, 28).scale(0.026).path(logo).fill("#172225").restore();
      doc.font("Helvetica-Bold").fontSize(12).fillColor("#172225").text("Fleet AI", 83, 35, { lineBreak: false });
      doc.font("Helvetica").fontSize(8).fillColor("#59686d").text("VEHICLE INTELLIGENCE / PRIVATE REPORT", 290, 37, { lineBreak: false });
      doc.fontSize(8).text(`${TEMPLATE_VERSION}  |  ${artifact.id || "Saved evidence snapshot"}`, 46, 752, { lineBreak: false });
      doc.text(`${i + 1} / ${range.count}`, 525, 752, { lineBreak: false });
    }
    doc.end();
  } catch (error) { doc.destroy(error); }
  return result;
}

async function sealReportPdf(data) {
  const buffer = await renderReportPdf(data);
  return { ...data, content: { ...data.content, pdf: { templateVersion: TEMPLATE_VERSION, mimeType: "application/pdf",
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"), base64: buffer.toString("base64") } } };
}

async function getReportPdf(artifact) {
  const saved = artifact.content?.pdf;
  if (!saved) return renderReportPdf(artifact); // Legacy reports retain their saved evidence.
  if (typeof saved.base64 !== "string" || saved.base64.length > Math.ceil(MAX_PDF_BYTES / 3) * 4) throw new Error("invalid_report_pdf");
  const buffer = Buffer.from(saved.base64, "base64");
  if (buffer.subarray(0, 5).toString() !== "%PDF-" || crypto.createHash("sha256").update(buffer).digest("hex") !== saved.sha256) throw new Error("report_pdf_integrity_failed");
  return buffer;
}

module.exports = { TEMPLATE_VERSION, renderReportPdf, sealReportPdf, getReportPdf };
