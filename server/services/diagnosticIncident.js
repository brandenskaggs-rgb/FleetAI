const crypto = require("node:crypto");
const { decodeCode } = require("../telematics/diagnostics/dtcCatalog");

function describeCodes(codes) {
  return (codes || []).map(item => {
    const decoded = decodeCode(item);
    return { ...decoded, ...(typeof item === "object" ? item : {}), ...(decoded.known ? { parameter: decoded.parameter, known: true, severity: decoded.severity } : {}) };
  });
}

// One open incident per fleet, vehicle and fault family, not per repeated scan.
// The transaction lock also covers concurrent manual scans and outbox replays.
async function recordIncidents(tx, scan) {
  const groups = new Map();
  for (const code of describeCodes(scan.codes)) {
    if (code.codeStatus === "permanent" || !code.code || code.severity === "info") continue;
    const family = ["P0420", "P0430"].includes(code.code) ? "catalyst-efficiency" : code.code;
    if (!groups.has(family)) groups.set(family, []);
    groups.get(family).push(code);
  }
  for (const family of [...groups.keys()].sort()) {
    const codes = groups.get(family);
    const severity = codes.some(c => c.severity === "critical") ? "critical" : "warning";
    const body = codes.map(c => c.code+" ("+(c.codeStatus || "reported")+"): "+c.parameter).join("; ")
      + ". Have a technician verify the cause. This is an ECU observation, not a predicted failure date.";
    await openIncident(tx,scan,"diagnostic_scan",family,severity,body);
  }
}
async function openIncident(tx,scan,type,family,severity,body) {
  const digest=crypto.createHash("sha256").update(JSON.stringify([type,scan.orgId,scan.vehicleId,family])).digest("hex");
  const where={orgId:scan.orgId,vehicleId:scan.vehicleId,dedupeKey:"INC:"+digest};
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${where.dedupeKey}, 0))`;
  const old=await tx.alert.findFirst({where,orderBy:{createdAt:"desc"}});
  if(old && (!old.resolved || !old.resolvedAt || new Date(scan.scannedAt)<=old.resolvedAt))return;
  const id=(type==="diagnostic_scan"?"DI_":"PI_")+scan.id+"."+digest.slice(0,16);
  await tx.alert.create({data:{...where,id,type,severity,explanation:body,createdAt:scan.scannedAt,
    recommendedChecks:["Review the recorded evidence with a technician."]}});
  await tx.notification.create({data:{orgId:scan.orgId,vehicleId:scan.vehicleId,eventId:id,recipientType:"fleet_manager",
    title:"Maintenance finding on "+scan.vehicleId,body,severity}});
}
function confirmedPredictionIncident(p,now=Date.now()) {
  const age=now-Date.parse(p.evidenceThrough);
  if(!Number.isFinite(age)||age < -5000 || age>120000 || p.insufficientData || p.insufficientHistory ||
    p.predictionSource!=="python_ml_ensemble" || p.stageSystem?.confirmed!==true ||
    (p.stageSystem.stage3 && p.stageSystem.stage3.verdict!=="CONFIRM"))return null;
  const signals=(p.topContributors||[]).map(c=>c.metric).filter(Boolean).slice(0,3);
  return "The vehicle model flagged a pattern for inspection at "+p.evidenceThrough+
    (signals.length?". Contributing signals: "+signals.join(", "):"")+
    ". This is a model warning, not a confirmed mechanical failure or a deadline.";
}
module.exports = { recordIncidents, describeCodes, openIncident, confirmedPredictionIncident };
