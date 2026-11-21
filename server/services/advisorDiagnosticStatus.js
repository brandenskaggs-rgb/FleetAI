const { isLiveDiagnosticRequest } = require("./liveDiagnosticService");
const { scanSession } = require("./liveScanSession");
const STATUS_FOLLOWUP = /^(?:is it (?:still )?(?:done|ready|running|finished)(?: yet)?|has it finished|did it finish|are you done|still running|any results|how long|how much longer|what did you find)[.!?\s]*$/i;
const RETRY_FOLLOWUP = /^(?:please\s+)?(?:try again|retry|run it again|check again|do it again)[.!?\s]*$/i;

function diagnosticIntent(message, history) {
  if (/^\s*(?:please\s+)?(?:analy[sz]e|review|summari[sz]e)\b.*\b(?:uploaded|received|recorded)\s+(?:sensor\s+)?(?:telemetry|readings|data)\b/i.test(message)) return "snapshot";
  if (/^\s*(?:please\s+)?(?:stop|cancel|end)\s+(?:(?:my|the|live|diagnostic|sensor)\s+)*scan\b/i.test(message)) return "stop";
  if (isLiveDiagnosticRequest(message)) return "run";
  const text = String(message || "").trim();
  // Client chat is conversational context only, never proof that a job exists.
  const userTurns = Array.isArray(history) ? history.slice(-8).filter(item => item?.role === "user").reverse() : [];
  let scanContext = false;
  for (const turn of userTurns) {
    const previous = String(turn.content || "").trim();
    if (/\b(scan|diagnostic)\b/i.test(previous)) { scanContext = true; break; }
    if (!STATUS_FOLLOWUP.test(previous) && !RETRY_FOLLOWUP.test(previous)) break;
  }
  if (scanContext && RETRY_FOLLOWUP.test(text)) return "run";
  if (/\b(scan|diagnostic)\b/i.test(text) && /\b(status|running|done|finished|complete|ready|results|progress|how long|still|did you|have you)\b/i.test(text)) return "status";
  if (scanContext && STATUS_FOLLOWUP.test(text)) return "status";
  return null;
}

async function diagnosticStatusReply(prisma, orgId, vehicleId) {
  const vehicle = await prisma.vehicle.findFirst({ where: { orgId, vehicleId }, select: { vehicleId: true } });
  if (!vehicle) return null;
  const session = await scanSession(prisma, orgId, vehicleId);
  if (session.status !== "idle") return { ok: true, source: "fleetai_sensor_watch", scanStatus: session.status,
    reply: session.message + (session.readings.length ? " Latest measurements: " + session.readings.slice(0, 5).map(r =>
      `${r.label}: ${r.value} ${r.unit} at ${new Date(r.at).toISOString()}`).join("; ") + "." : ""),
    session, artifacts: [], proposedActions: [] };
  const artifact = await prisma.advisorArtifact.findFirst({
    where: { orgId, type: "live_diagnostic", content: { path: ["scope", "vehicleId"], equals: vehicleId } },
    orderBy: { createdAt: "desc" }, select: { id: true, title: true, type: true, createdAt: true }
  });
  return { ok: true, source: "fleetai_received_telemetry", model: null, scanStatus: "not_running",
    reply: artifact
      ? `There is no background diagnostic scan running. The last saved analysis completed at ${new Date(artifact.createdAt).toISOString()}. It checked uploaded readings at that time, not a continuing ECU scan. Open the report below, or ask me to run a live diagnostic scan for a new analysis.`
      : "There is no background diagnostic scan running, and I found no saved live diagnostic analysis for this vehicle. Any earlier message saying it was running was incorrect. Ask me to start a live diagnostic scan to request fresh readings from the tablet.",
    artifacts: artifact ? [{ ...artifact, downloadUrl: `/api/advisor/artifacts/${encodeURIComponent(artifact.id)}/download` }] : [], proposedActions: [] };
}

// Defense in depth for ordinary chat: no model-generated scan execution receipts.
function guardDiagnosticClaims(reply) {
  const text = String(reply || "");
  const scan = /\b(scan|diagnostic|diagnostics)\b/i.test(text);
  const execution = /\b(?:i(?:['\u2019]ve| have)?\s+(?:just\s+)?(?:sent|started|launched|initiated|triggered|queued|completed|ran|run)|(?:scan|diagnostic|diagnostics)[^.\n]{0,55}\b(?:running|in progress|underway|started|complete|finished)|i(?:['\u2019]m| am)\s+(?:running|scanning))\b/i.test(text);
  const promise = /\b(?:i(?:['\u2019]ll| will)|we(?:['\u2019]ll| will))\b[^.\n]{0,60}\b(?:notify|alert you|let you know|send you|keep (?:watching|monitoring))\b/i.test(text);
  if ((scan && execution) || promise) return "I can't verify an active background scan from that response. Ask for scan status to check the tablet, or ask me to run a live diagnostic scan and confirm the request.";
  return text;
}

module.exports = { diagnosticIntent, diagnosticStatusReply, guardDiagnosticClaims };
