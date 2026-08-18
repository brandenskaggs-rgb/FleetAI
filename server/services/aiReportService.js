// AI Report Service — LLaMA 3.3 70B (via Groq) writes narrative ONLY.
// The ML engine computes all numbers via computeFullPrediction().
// This service receives those computed values and asks the LLM to narrate them.
// Never passes raw telemetry or asks the LLM to calculate anything.

const db = require("../db");
const { completeChat, getAiProviderStatus } = require("./aiProviderService");

// Cooldown: don't regenerate a report within this many minutes
const REPORT_COOLDOWN_MINUTES = Number(process.env.REPORT_COOLDOWN_MINUTES || 60);

async function callGroq(prompt) {
  const completion = await completeChat(
    [{ role: "user", content: prompt }],
    { provider: "groq", maxTokens: 600, temperature: 0.3, timeoutMs: 20_000 }
  );
  return completion;
}

function formatSensorRiskTable(sensorRisks) {
  if (!sensorRisks || !Object.keys(sensorRisks).length) return "  No sensor data available.";
  return Object.entries(sensorRisks)
    .sort(([, a], [, b]) => b - a)
    .map(([k, score]) => {
      const tier = score >= 70 ? "DANGER" : score >= 30 ? "WARNING" : "NORMAL";
      return `  ${k.padEnd(30)} ${String(score).padStart(3)}/100  [${tier}]`;
    })
    .join("\n");
}

function formatWeeksToFailureTable(wtf) {
  if (!wtf || !Object.keys(wtf).length) return "  No sensors trending toward danger threshold.";
  return Object.entries(wtf)
    .sort(([, a], [, b]) => a - b)
    .map(([k, weeks]) => `  ${k.padEnd(30)} ~${weeks} weeks`)
    .join("\n");
}

function formatRiskTable(risk) {
  if (!risk) return "  Insufficient data for system risk assessment.";
  const rows = [];
  if (risk.cooling)  rows.push(`  Cooling System:     7d=${risk.cooling.risk7}%  14d=${risk.cooling.risk14}%  30d=${risk.cooling.risk30}%`);
  if (risk.charging) rows.push(`  Charging System:    7d=${risk.charging.risk7}%  14d=${risk.charging.risk14}%  30d=${risk.charging.risk30}%`);
  if (risk.fuel)     rows.push(`  Fuel System:        7d=${risk.fuel.risk7}%  14d=${risk.fuel.risk14}%  30d=${risk.fuel.risk30}%`);
  return rows.length ? rows.join("\n") : "  No system risks computed.";
}

function buildPrompt(prediction, vehicleMeta) {
  const vehicleId = prediction.vehicleId;
  const vin = vehicleMeta?.vin || "Unknown";
  const year = vehicleMeta?.year || "Unknown";
  const make = vehicleMeta?.make || "Unknown";
  const healthScore = prediction.healthScore ?? "N/A";
  const anomalyScore = prediction.anomalyScore ?? "N/A";
  const sampleCount = prediction.sampleCount;
  const reportDate = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  const topContributors = (prediction.topContributors || [])
    .map((c) => `  - ${c.metric}: z-score ${c.zScore?.toFixed(2)}, value ${c.value} (${c.reason})`)
    .join("\n") || "  None identified.";

  return `You are a professional fleet maintenance analyst generating a report for a fleet manager (not a data scientist). All numbers below were computed by the ML engine — do not recalculate or question them. Your only job is to write clear, professional, actionable prose that explains what these numbers mean.

=== VEHICLE ===
Vehicle ID: ${vehicleId}
VIN: ${vin}
Year: ${year}   Make: ${make}
Report Date: ${reportDate}
Telemetry Samples: ${sampleCount}

=== OVERALL HEALTH ===
Health Score: ${healthScore}/100  (100 = perfect, 0 = critical)
Anomaly Score: ${anomalyScore}/100  (higher = more anomalous behavior detected)

=== PER-SENSOR RISK SCORES (0–100, computed from thresholds + baseline deviation) ===
${formatSensorRiskTable(prediction.sensorRisks)}

=== PROJECTED WEEKS TO FAILURE (linear regression to danger threshold) ===
${formatWeeksToFailureTable(prediction.weeksToFailure)}

=== SYSTEM RISK PREDICTIONS ===
${formatRiskTable(prediction.risk)}

=== TOP ANOMALY CONTRIBUTORS ===
${topContributors}

Write a 3–4 paragraph maintenance report in plain English for a fleet manager:
1. Start with an overall health assessment referencing the health score and which sensors are in WARNING or DANGER tier.
2. Detail which systems need immediate attention, citing the weeks-to-failure projections directly (e.g. "coolant temp is projected to hit the danger threshold in approximately X weeks").
3. State maintenance priorities by urgency (critical / this week / this month).
4. End with a recommended action list, numbered, most urgent first.

Do not repeat the raw numbers table — just narrate them naturally in the paragraphs.`;
}

// Generate and persist an AI narrative report for a vehicle.
// prediction = output of computeFullPrediction()
// vehicleMeta = { vin, year, make } from vehicle_capabilities
async function generateReport(prediction, vehicleMeta = {}) {
  const providerStatus = getAiProviderStatus("groq");
  if (!providerStatus.available) {
    return { narrative: buildFallbackNarrative(prediction), source: "deterministic" };
  }

  // Cooldown check
  const existing = await db.getLatestAiReport(prediction.vehicleId);
  if (existing) {
    const ageMinutes = (Date.now() - new Date(existing.createdAt).getTime()) / 60000;
    if (ageMinutes < REPORT_COOLDOWN_MINUTES) {
      return { ...existing, source: "cached" };
    }
  }

  const prompt = buildPrompt(prediction, vehicleMeta);
  let narrative;
  let source = "groq";
  let modelUsed = providerStatus.model;
  try {
    const completion = await callGroq(prompt);
    narrative = completion.content;
    modelUsed = completion.model;
  } catch (err) {
    console.warn(`[AI-REPORT] Groq call failed, using deterministic fallback: ${err.code || "AI_ERROR"}`);
    narrative = buildFallbackNarrative(prediction);
    source = "deterministic_fallback";
    modelUsed = null;
  }

  let reportId = null;
  try {
    reportId = await db.insertAiReport({
      orgId: prediction.orgId || null,
      vehicleId: prediction.vehicleId,
      narrative,
      predictionSnapshot: prediction,
      modelUsed,
      createdAt: new Date().toISOString()
    });
  } catch (err) {
    console.warn("[AI-REPORT] DB insert failed — returning narrative without persisting:", err.message);
  }

  return {
    id: reportId,
    vehicleId: prediction.vehicleId,
    narrative,
    createdAt: new Date().toISOString(),
    modelUsed,
    source
  };
}

// Rule-based fallback when AI is disabled or unavailable
function buildFallbackNarrative(prediction) {
  const { vehicleId, healthScore, sensorRisks = {}, weeksToFailure = {}, insufficientData } = prediction;

  if (insufficientData) {
    return `Vehicle ${vehicleId} is still in the baseline learning phase (${prediction.sampleCount} samples collected; 200 required). Risk scoring and failure projections will become available once sufficient telemetry history is established. Continue normal operations and check back after more driving data is collected.`;
  }

  const dangerSensors = Object.entries(sensorRisks).filter(([, s]) => s >= 70).map(([k]) => k);
  const warnSensors   = Object.entries(sensorRisks).filter(([, s]) => s >= 30 && s < 70).map(([k]) => k);
  const imminent      = Object.entries(weeksToFailure).filter(([, w]) => w <= 4).map(([k, w]) => `${k} (~${w} wk)`);
  const upcoming      = Object.entries(weeksToFailure).filter(([, w]) => w > 4 && w <= 12).map(([k, w]) => `${k} (~${w} wk)`);

  const lines = [];
  lines.push(`Vehicle ${vehicleId} has an overall health score of ${healthScore}/100.`);

  if (dangerSensors.length) {
    lines.push(`CRITICAL: The following sensors are in the DANGER tier and require immediate inspection: ${dangerSensors.join(", ")}.`);
  }
  if (warnSensors.length) {
    lines.push(`WARNING: These sensors are elevated and should be monitored: ${warnSensors.join(", ")}.`);
  }
  if (imminent.length) {
    lines.push(`Failure projections indicate these sensors may reach critical thresholds within 4 weeks: ${imminent.join("; ")}. Schedule service immediately.`);
  }
  if (upcoming.length) {
    lines.push(`The following sensors are trending toward thresholds within 4–12 weeks: ${upcoming.join("; ")}. Plan maintenance accordingly.`);
  }
  if (!dangerSensors.length && !warnSensors.length) {
    lines.push("All monitored sensors are within normal operating ranges. Continue standard maintenance schedule.");
  }

  return lines.join(" ");
}

module.exports = { generateReport, buildFallbackNarrative };
