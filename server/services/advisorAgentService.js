const REPORT_ACTION_WORDS = /\b(create|generate|build|prepare|export|make|produce|write|give me|pull)\b/i;
const REPORT_NOUNS = /\b(report|brief|summary|risk assessment|drive log|trip log)\b/i;
const WORK_ORDER_WORDS = /\b(create|open|schedule|add|start)\b.*\bwork order\b|\bwork order\b.*\b(create|open|schedule|add|start)\b/i;

function reportTypeFor(message) {
  const text = String(message || "").toLowerCase();
  if (/\b(hos|eld|dot|compliance|violation)\b/.test(text)) return "compliance";
  if (/\b(drive|trip|telemetry|route)\b/.test(text)) return "drive";
  if (/\b(maintenance|service|work order|repair|parts)\b/.test(text)) return "maintenance";
  if (/\b(fuel|cost|expense|spend|mpg)\b/.test(text)) return "cost";
  if (/\b(risk|health|breakdown|alert|fault)\b/.test(text)) return "risk";
  return "fleet";
}

function reportTitle(type, organizationName) {
  const names = {
    compliance: "Compliance activity report",
    drive: "Drive activity report",
    maintenance: "Maintenance operations report",
    cost: "Fleet cost report",
    risk: "Fleet risk report",
    fleet: "Fleet operations report"
  };
  return `${organizationName || "Fleet"} - ${names[type] || names.fleet}`;
}

function resolveVehicleFromQuestion(message, context) {
  if (context.selectedVehicleId) return context.selectedVehicleId;
  const text = String(message || "").toLowerCase();
  const match = (context.assets || []).find((vehicle) =>
    [vehicle.vehicleId, vehicle.unitName]
      .filter(Boolean)
      .some((value) => text.includes(String(value).toLowerCase()))
  );
  return match?.vehicleId || null;
}

function planAdvisorActions(message, context) {
  const text = String(message || "").trim();
  const actions = [];
  if (REPORT_ACTION_WORDS.test(text) && REPORT_NOUNS.test(text)) {
    const type = reportTypeFor(text);
    actions.push({
      action: "generate_report",
      mode: "automatic",
      reportType: type,
      title: reportTitle(type, context.organization?.name),
      vehicleId: resolveVehicleFromQuestion(text, context)
    });
  }
  if (WORK_ORDER_WORDS.test(text)) {
    const vehicleId = resolveVehicleFromQuestion(text, context);
    if (vehicleId) {
      actions.push({
        action: "create_work_order",
        mode: "confirmation_required",
        label: `Create work order for ${vehicleId}`,
        payload: {
          vehicleId,
          title: `Advisor follow-up: ${text.slice(0, 120)}`,
          description: text.slice(0, 500),
          priority: /\b(critical|urgent|immediately)\b/i.test(text) ? "critical" : /\b(high|soon)\b/i.test(text) ? "high" : "normal"
        }
      });
    }
  }
  return actions;
}

function reportSections(type, context, vehicleId = null) {
  const scoped = (records) => (vehicleId ? (records || []).filter((record) => !record?.vehicleId || record.vehicleId === vehicleId) : (records || []));
  const common = {
    generatedAt: context.generatedAt,
    lookbackDays: context.lookbackDays,
    organization: context.organization,
    requestedVehicleId: vehicleId,
    riskOverviewScope: "organization",
    recordCounts: context.recordCounts,
    riskOverview: context.riskOverview
  };
  if (type === "drive") return { ...common, driveLogs: scoped(context.driveLogs), vehicleHealth: scoped(context.vehicleHealth), alerts: scoped(context.alerts) };
  if (type === "maintenance") return { ...common, maintenance: scoped(context.maintenance), workOrders: scoped(context.workOrders), inspections: { dvir: scoped(context.inspections?.dvir), diagnosticScans: scoped(context.inspections?.diagnosticScans) }, vehicleHealth: scoped(context.vehicleHealth) };
  if (type === "compliance") return { ...common, compliance: context.compliance, inspections: context.inspections, drivers: context.drivers };
  if (type === "cost") return { ...common, fuel: scoped(context.fuel), maintenance: scoped(context.maintenance), assets: scoped(context.assets) };
  if (type === "risk") return { ...common, vehicleHealth: scoped(context.vehicleHealth), alerts: scoped(context.alerts), driveLogs: scoped(context.driveLogs), inspections: { dvir: scoped(context.inspections?.dvir), diagnosticScans: scoped(context.inspections?.diagnosticScans) }, workOrders: scoped(context.workOrders) };
  return { ...common, assets: context.assets, drivers: context.drivers, vehicleHealth: context.vehicleHealth, alerts: context.alerts, driveLogs: context.driveLogs, maintenance: context.maintenance, compliance: context.compliance };
}

function buildReportArtifact({ action, context, reply, request, userId }) {
  return {
    orgId: context.organization.id,
    userId: userId || null,
    type: action.reportType,
    title: action.title,
    request,
    content: {
      summary: reply,
      scope: action.vehicleId ? { vehicleId: action.vehicleId } : { organization: context.organization.name },
      sources: reportSections(action.reportType, context, action.vehicleId)
    }
  };
}

function renderReportText(artifact) {
  const content = artifact.content || {};
  const lines = [
    artifact.title,
    "=".repeat(Math.min(artifact.title.length, 80)),
    `Generated: ${new Date(artifact.createdAt).toISOString()}`,
    `Report type: ${artifact.type}`,
    `Requested analysis: ${artifact.request}`,
    "",
    "Executive summary",
    "-----------------",
    String(content.summary || "No narrative summary was generated."),
    "",
    "Fleet AI evidence",
    "-----------------",
    JSON.stringify(content.sources || {}, null, 2),
    "",
    "Decision-support notice: Fleet AI findings are advisory. Qualified personnel remain responsible for maintenance, safety, and compliance decisions."
  ];
  return lines.join("\n");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function humanize(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function displayValue(value) {
  if (value === null || value === undefined || value === "") return "--";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function renderEvidenceSection(title, value, depth = 0) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    if (!value.length) return `<section><h${Math.min(2 + depth, 4)}>${escapeHtml(humanize(title))}</h${Math.min(2 + depth, 4)}><p class="empty">No records were available for this section.</p></section>`;
    const objectRows = value.filter((row) => row && typeof row === "object" && !Array.isArray(row));
    if (!objectRows.length) return `<section><h${Math.min(2 + depth, 4)}>${escapeHtml(humanize(title))}</h${Math.min(2 + depth, 4)}><p>${escapeHtml(value.join(", "))}</p></section>`;
    const columns = [...new Set(objectRows.flatMap((row) => Object.keys(row)))].filter((key) => key !== "evidenceRef").slice(0, 8);
    return `<section><h${Math.min(2 + depth, 4)}>${escapeHtml(humanize(title))}</h${Math.min(2 + depth, 4)}><div class="tableWrap"><table><thead><tr>${columns.map((column) => `<th>${escapeHtml(humanize(column))}</th>`).join("")}</tr></thead><tbody>${objectRows.map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(displayValue(row[column]))}</td>`).join("")}</tr>`).join("")}</tbody></table></div></section>`;
  }
  if (typeof value === "object") {
    const simple = Object.entries(value).filter(([, item]) => item === null || typeof item !== "object");
    const nested = Object.entries(value).filter(([, item]) => item && typeof item === "object");
    return `<section><h${Math.min(2 + depth, 4)}>${escapeHtml(humanize(title))}</h${Math.min(2 + depth, 4)}>${simple.length ? `<dl>${simple.map(([key, item]) => `<div><dt>${escapeHtml(humanize(key))}</dt><dd>${escapeHtml(displayValue(item))}</dd></div>`).join("")}</dl>` : ""}${nested.map(([key, item]) => renderEvidenceSection(key, item, depth + 1)).join("")}</section>`;
  }
  return `<section><h${Math.min(2 + depth, 4)}>${escapeHtml(humanize(title))}</h${Math.min(2 + depth, 4)}><p>${escapeHtml(displayValue(value))}</p></section>`;
}

function renderReportHtml(artifact) {
  const content = artifact.content || {};
  const summary = escapeHtml(content.summary || "No narrative summary was generated.").replace(/\r?\n/g, "<br>");
  const evidence = Object.entries(content.sources || {}).map(([title, value]) => renderEvidenceSection(title, value)).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(artifact.title)}</title><style>:root{font-family:Arial,sans-serif;color:#111827;background:#fff}*{box-sizing:border-box}body{margin:0;padding:48px;line-height:1.5}header{padding-bottom:26px;border-bottom:3px solid #1f5eff;margin-bottom:30px}.brand{font-weight:800;color:#1f5eff;letter-spacing:.04em;text-transform:uppercase;font-size:12px}h1{font-size:30px;margin:10px 0 8px}h2{font-size:20px;margin:30px 0 12px}h3{font-size:16px;margin:22px 0 10px}.meta,.notice,.empty{color:#64748b;font-size:12px}.summary{font-size:16px;max-width:900px;background:#f6f8fc;padding:22px;margin:0 0 28px}dl{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:0}dl div{background:#f8fafc;padding:12px}dt{font-size:10px;text-transform:uppercase;color:#64748b;font-weight:700}dd{margin:4px 0 0;font-weight:700}.tableWrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:11px}th{text-align:left;text-transform:uppercase;color:#64748b;font-size:9px;letter-spacing:.05em}th,td{padding:9px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top}footer{margin-top:40px;padding-top:18px;border-top:1px solid #e5e7eb}.actions{position:fixed;right:20px;top:20px}@media print{body{padding:20px}.actions{display:none}}@media(max-width:700px){body{padding:22px}dl{grid-template-columns:1fr}}</style></head><body><button class="actions" onclick="window.print()">Print / Save PDF</button><header><div class="brand">Fleet AI</div><h1>${escapeHtml(artifact.title)}</h1><div class="meta">Generated ${escapeHtml(new Date(artifact.createdAt).toLocaleString())} &middot; ${escapeHtml(artifact.type)} report</div><div class="meta">Requested analysis: ${escapeHtml(artifact.request)}</div></header><main><h2>Executive summary</h2><div class="summary">${summary}</div><h2>Supporting fleet records</h2>${evidence}</main><footer><p class="notice">Fleet AI findings are advisory. Qualified personnel remain responsible for maintenance, safety, and compliance decisions.</p></footer></body></html>`;
}

module.exports = {
  buildReportArtifact,
  planAdvisorActions,
  renderReportHtml,
  renderReportText,
  reportSections,
  reportTypeFor,
  resolveVehicleFromQuestion
};
