const DRIVE_SESSION_GAP_MS = 5 * 60 * 1000;
const DEFAULT_LOOKBACK_DAYS = 30;

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function median(values) {
  const usable = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!usable.length) return null;
  const middle = Math.floor(usable.length / 2);
  return usable.length % 2 ? usable[middle] : (usable[middle - 1] + usable[middle]) / 2;
}

function splitDriveSessions(samples) {
  const sorted = [...samples].sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const sessions = [];
  let current = [];
  for (const sample of sorted) {
    const previous = current.at(-1);
    if (previous && new Date(sample.ts) - new Date(previous.ts) > DRIVE_SESSION_GAP_MS) {
      sessions.push(current);
      current = [];
    }
    current.push(sample);
  }
  if (current.length) sessions.push(current);
  return sessions;
}

function summarizeDriveSession(vehicleId, samples) {
  if (!samples.length) return null;
  const start = new Date(samples[0].ts);
  const end = new Date(samples.at(-1).ts);
  const running = samples.filter((sample) => finiteNumber(sample.metrics?.rpm) > 400);
  const speeds = samples.map((sample) => finiteNumber(sample.metrics?.vehicleSpeed)).filter(Number.isFinite);
  const movingSpeeds = speeds.filter((speed) => speed > 1);
  const coolant = samples.map((sample) => finiteNumber(sample.metrics?.coolantTemp)).filter(Number.isFinite);
  const voltage = running.map((sample) => finiteNumber(sample.metrics?.batteryVoltage)).filter((value) => Number.isFinite(value) && value > 1);
  let estimatedDistanceKm = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const elapsedHours = Math.min(new Date(samples[index].ts) - new Date(samples[index - 1].ts), 15_000) / 3_600_000;
    const speed = finiteNumber(samples[index - 1].metrics?.vehicleSpeed);
    if (Number.isFinite(speed) && speed >= 0) estimatedDistanceKm += speed * elapsedHours;
  }
  return {
    evidenceRef: `drive:${vehicleId}:${start.toISOString()}`,
    vehicleId,
    startedAt: start.toISOString(),
    endedAt: end.toISOString(),
    durationMinutes: round((end - start) / 60_000, 1),
    sampleCount: samples.length,
    engineRunningSamples: running.length,
    estimatedDistanceKm: round(estimatedDistanceKm, 1),
    averageMovingSpeedKph: round(average(movingSpeeds), 1),
    maximumSpeedKph: speeds.length ? round(Math.max(...speeds), 1) : null,
    maximumCoolantTempC: coolant.length ? round(Math.max(...coolant), 1) : null,
    typicalRunningVoltage: round(median(voltage), 2)
  };
}

function summarizeDriveSessions(samples, limit = 20) {
  const byVehicle = new Map();
  for (const sample of samples) {
    if (!byVehicle.has(sample.vehicleId)) byVehicle.set(sample.vehicleId, []);
    byVehicle.get(sample.vehicleId).push(sample);
  }
  const summaries = [];
  for (const [vehicleId, rows] of byVehicle) {
    for (const session of splitDriveSessions(rows)) {
      const summary = summarizeDriveSession(vehicleId, session);
      if (summary && (summary.durationMinutes > 0 || summary.sampleCount > 1)) summaries.push(summary);
    }
  }
  return summaries.sort((a, b) => new Date(b.endedAt) - new Date(a.endedAt)).slice(0, limit);
}

function dutyLabel(eventType, eventCode) {
  if (Number(eventType) !== 1) return null;
  return ({ 1: "off_duty", 2: "sleeper_berth", 3: "driving", 4: "on_duty" })[Number(eventCode)] || "other_duty_status";
}

function buildRiskOverview({ alerts, modelStates, workOrders, dvirRecords, eldDiagnostics, diagnosticScans }) {
  const activeAlerts = alerts.filter((alert) => !alert.resolved);
  const healthScores = modelStates.map((state) => finiteNumber(state.healthScore)).filter(Number.isFinite);
  const now = Date.now();
  return {
    activeCriticalAlerts: activeAlerts.filter((alert) => String(alert.severity).toLowerCase() === "critical").length,
    activeWarningAlerts: activeAlerts.filter((alert) => String(alert.severity).toLowerCase() === "warning").length,
    vehiclesBelow70Health: modelStates.filter((state) => finiteNumber(state.healthScore) < 70).length,
    lowestVehicleHealthScore: healthScores.length ? Math.min(...healthScores) : null,
    openWorkOrders: workOrders.filter((order) => !["complete", "completed", "closed"].includes(String(order.status).toLowerCase())).length,
    overdueWorkOrders: workOrders.filter((order) => order.dueDate && new Date(order.dueDate).getTime() < now && !["complete", "completed", "closed"].includes(String(order.status).toLowerCase())).length,
    failedInspections: dvirRecords.filter((record) => ["fail", "failed", "unsafe"].includes(String(record.status || record.result).toLowerCase())).length,
    activeEldDiagnostics: eldDiagnostics.filter((item) => !["cleared", "resolved"].includes(String(item.status).toLowerCase())).length,
    recentDiagnosticScansRequiringAttention: diagnosticScans.filter((scan) => ["critical", "warning"].includes(String(scan.severity).toLowerCase())).length
  };
}

function matchesOrg(item, orgId) {
  return String(item?.orgId || "") === String(orgId || "");
}

function sanitizeLegacyRecords(records, orgId, limit, mapper) {
  return (Array.isArray(records) ? records : [])
    .filter((record) => matchesOrg(record, orgId))
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || b.date || 0) - new Date(a.updatedAt || a.createdAt || a.date || 0))
    .slice(0, limit)
    .map(mapper);
}

async function buildFleetAdvisorContext({ db, orgId, query, selectedVehicleId, legacyData = {}, now = new Date() }) {
  const prisma = db.getPrisma();
  const lookback = new Date(now.getTime() - DEFAULT_LOOKBACK_DAYS * 86_400_000);
  const selectedId = String(selectedVehicleId || "").trim();
  const vehicleWhere = { orgId };
  const sampleWhere = { vehicle: { orgId }, ts: { gte: lookback } };
  if (selectedId) sampleWhere.vehicleId = selectedId;

  const [org, vehicles, drivers, alerts, modelRows, samples, maintenance, workOrders, scans, fuelEvents, aiReports, predictionRuns, eldEvents, eldDiagnostics, certifications] = await Promise.all([
    prisma.org.findUnique({ where: { id: orgId }, select: { id: true, name: true, status: true } }),
    prisma.vehicle.findMany({ where: vehicleWhere, orderBy: { unitName: "asc" }, take: 100 }),
    prisma.driver.findMany({ where: { orgId }, orderBy: { updatedAt: "desc" }, take: 100 }),
    prisma.alert.findMany({ where: { orgId }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.modelState.findMany({ where: { orgId }, orderBy: { updatedAt: "desc" }, take: 100 }),
    prisma.telemetrySample.findMany({ where: sampleWhere, orderBy: { ts: "desc" }, take: 2500, select: { vehicleId: true, ts: true, metrics: true } }),
    prisma.maintenanceLog.findMany({ where: { orgId }, orderBy: { performedAt: "desc" }, take: 50 }),
    prisma.workOrder.findMany({ where: { orgId }, orderBy: { updatedAt: "desc" }, take: 50 }),
    prisma.diagnosticScan.findMany({ where: { orgId }, orderBy: { scannedAt: "desc" }, take: 30 }),
    prisma.fuelEvent.findMany({ where: { orgId }, orderBy: { createdAt: "desc" }, take: 40 }),
    prisma.aiReport.findMany({ where: { orgId }, orderBy: { createdAt: "desc" }, take: 12 }),
    prisma.mlPredictionRun.findMany({ where: { orgId }, orderBy: { createdAt: "desc" }, take: 30 }),
    prisma.eldEvent.findMany({ where: { orgId }, orderBy: { occurredAt: "desc" }, take: 100 }),
    prisma.eldDiagnostic.findMany({ where: { orgId }, orderBy: { detectedAt: "desc" }, take: 30 }),
    prisma.eldRecordCertification.findMany({ where: { orgId }, orderBy: { certifiedAt: "desc" }, take: 30 })
  ]);

  const allowedVehicleIds = new Set(vehicles.map((vehicle) => vehicle.vehicleId));
  const scopedSelectedVehicleId = selectedId && allowedVehicleIds.has(selectedId) ? selectedId : null;
  const modelStates = modelRows.map((row) => ({ ...row.state, vehicleId: row.vehicleId, updatedAt: iso(row.updatedAt) }));
  const driveLogs = summarizeDriveSessions(samples, 24);
  const dvirRecords = sanitizeLegacyRecords(legacyData.dvirRecords, orgId, 30, (record) => ({
    evidenceRef: `dvir:${record.id}`,
    id: record.id,
    vehicleId: record.vehicleId,
    driverId: record.driverId,
    status: record.status || record.result,
    defects: record.defects || record.failedItems || [],
    notes: record.notes || record.inspectorNotes || "",
    createdAt: record.createdAt || record.date
  }));
  const dispatchJobs = sanitizeLegacyRecords(legacyData.dispatchJobs, orgId, 30, (job) => ({
    evidenceRef: `dispatch:${job.id}`,
    id: job.id,
    vehicleId: job.vehicleId,
    driverId: job.driverId,
    origin: job.origin,
    destination: job.destination,
    status: job.status,
    eta: job.eta,
    updatedAt: job.updatedAt || job.createdAt
  }));

  const context = {
    generatedAt: now.toISOString(),
    lookbackDays: DEFAULT_LOOKBACK_DAYS,
    question: String(query || "").slice(0, 2000),
    organization: org,
    selectedVehicleId: scopedSelectedVehicleId,
    recordCounts: {
      vehicles: vehicles.length,
      drivers: drivers.length,
      alerts: alerts.length,
      telemetrySamples: samples.length,
      driveSessions: driveLogs.length,
      maintenanceLogs: maintenance.length,
      workOrders: workOrders.length,
      dvirRecords: dvirRecords.length,
      diagnosticScans: scans.length,
      fuelEvents: fuelEvents.length,
      dispatchJobs: dispatchJobs.length,
      savedAiReports: aiReports.length,
      predictionRuns: predictionRuns.length,
      eldEvents: eldEvents.length,
      eldDiagnostics: eldDiagnostics.length,
      eldCertifications: certifications.length
    },
    assets: vehicles.map((vehicle) => ({ vehicleId: vehicle.vehicleId, unitName: vehicle.unitName, year: vehicle.year, make: vehicle.make, model: vehicle.model, type: vehicle.type })),
    drivers: drivers.map((driver) => ({ driverId: driver.driverId, name: [driver.firstName, driver.lastName].filter(Boolean).join(" "), status: driver.status, eldExempt: driver.eldExempt })),
    riskOverview: null,
    vehicleHealth: modelStates.map((state) => ({
      evidenceRef: `health:${state.vehicleId}:${state.updatedAt}`,
      vehicleId: state.vehicleId,
      healthScore: finiteNumber(state.healthScore),
      riskProbability: finiteNumber(state.riskProbability),
      confidence: finiteNumber(state.confidence),
      confidenceStage: state.confidenceStage,
      dataQuality: state.dataQuality,
      topContributors: Array.isArray(state.topContributors) ? state.topContributors.slice(0, 5) : [],
      chargingEvidence: state.chargingEvidence || null,
      updatedAt: state.updatedAt
    })),
    alerts: alerts.map((alert) => ({
      evidenceRef: `alert:${alert.id}`,
      id: alert.id,
      vehicleId: alert.vehicleId,
      type: alert.type,
      severity: alert.severity,
      explanation: alert.explanation,
      recommendedChecks: alert.recommendedChecks,
      acknowledged: alert.acknowledged,
      resolved: alert.resolved,
      createdAt: iso(alert.createdAt)
    })),
    driveLogs,
    maintenance: maintenance.map((record) => ({ evidenceRef: `maintenance:${record.id}`, id: record.id, vehicleId: record.vehicleId, serviceType: record.serviceType || record.maintenanceType, description: record.description, status: record.status, performedAt: iso(record.performedAt || record.serviceDate), totalCost: finiteNumber(record.totalCost), odometerMiles: finiteNumber(record.odometerMiles) })),
    workOrders: workOrders.map((order) => ({ evidenceRef: `work-order:${order.id}`, id: order.id, vehicleId: order.vehicleId, title: order.title, description: order.description, status: order.status, priority: order.priority, dueDate: iso(order.dueDate), updatedAt: iso(order.updatedAt) })),
    inspections: {
      dvir: dvirRecords,
      diagnosticScans: scans.map((scan) => ({ evidenceRef: `diagnostic-scan:${scan.id}`, id: scan.id, vehicleId: scan.vehicleId, driverId: scan.driverId, severity: scan.severity, driveability: scan.driveability, codeCount: scan.codeCount, codes: scan.codes, scannedAt: iso(scan.scannedAt) }))
    },
    compliance: {
      dutyEvents: eldEvents.map((event) => ({ evidenceRef: `eld-event:${event.id}`, id: event.id, vehicleId: event.vehicleId, driverId: event.driverId, dutyStatus: dutyLabel(event.eventType, event.eventCode), eventType: event.eventType, eventCode: event.eventCode, occurredAt: iso(event.occurredAt), annotation: event.annotation, malfunctionIndicator: event.malfunctionIndicator, diagnosticIndicator: event.diagnosticIndicator })),
      diagnostics: eldDiagnostics.map((item) => ({ evidenceRef: `eld-diagnostic:${item.id}`, id: item.id, vehicleId: item.vehicleId, driverId: item.driverId, kind: item.kind, code: item.code, status: item.status, detectedAt: iso(item.detectedAt), clearedAt: iso(item.clearedAt) })),
      recentCertifications: certifications.map((item) => ({ driverId: item.driverId, recordDate: item.recordDate, certifiedAt: iso(item.certifiedAt) }))
    },
    fuel: fuelEvents.map((event) => ({ evidenceRef: `fuel:${event.id}`, id: event.id, vehicleId: event.vehicleId, startedAt: iso(event.tsStart), endedAt: iso(event.tsEnd), gallonsEstimated: finiteNumber(event.gallonsEstimated), deltaFuelPct: finiteNumber(event.deltaFuelPct), confidence: finiteNumber(event.confidence), status: event.status })),
    dispatch: dispatchJobs,
    reports: aiReports.map((report) => ({ evidenceRef: `report:${report.id}`, id: report.id, vehicleId: report.vehicleId, narrative: String(report.narrative || "").slice(0, 1200), modelUsed: report.modelUsed, createdAt: iso(report.createdAt) })),
    predictions: predictionRuns.map((run) => ({ evidenceRef: `prediction:${run.id}`, id: run.id, vehicleId: run.vehicleId, source: run.source, modelVersion: run.modelVersion, confidence: finiteNumber(run.confidence), riskProbability: finiteNumber(run.riskProbability), healthScore: finiteNumber(run.healthScore), createdAt: iso(run.createdAt) }))
  };
  context.riskOverview = buildRiskOverview({ alerts, modelStates, workOrders, dvirRecords, eldDiagnostics, diagnosticScans: scans });
  return context;
}

module.exports = {
  DEFAULT_LOOKBACK_DAYS,
  DRIVE_SESSION_GAP_MS,
  buildFleetAdvisorContext,
  buildRiskOverview,
  splitDriveSessions,
  summarizeDriveSession,
  summarizeDriveSessions
};
