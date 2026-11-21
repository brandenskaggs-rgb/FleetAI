const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_LENGTH = 1200;

function normalizeAdvisorHistory(history, sanitizeString) {
  if (!Array.isArray(history)) return [];
  return history
    .slice(-MAX_HISTORY_MESSAGES)
    .map((entry) => {
      const role = entry?.role === "assistant" ? "assistant" : entry?.role === "user" ? "user" : "";
      const content = sanitizeString(entry?.content || "", MAX_HISTORY_MESSAGE_LENGTH);
      return role && content ? { role, content } : null;
    })
    .filter(Boolean);
}

function buildAdvisorSystemPrompt(context) {
  return [
    "You are Fleet Advisor, the in-product operations assistant for Fleet AI.",
    "Talk like an experienced fleet maintenance and operations manager speaking with a colleague. Be natural, calm, direct, and specific. Use contractions when they sound normal.",
    "Answer the question first. Then explain the evidence and the next practical step only when it helps.",
    "Prefer two to four short paragraphs. Use a short list only when the user genuinely needs several actions or comparisons.",
    "Do not use Markdown headings, bold markers, asterisks, backticks, or canned report labels. Do not sound like a policy document or a customer-service script.",
    "Never say 'the data you provided.' The fleet context comes from Fleet AI, so say 'Fleet AI shows,' 'the latest reading shows,' or 'I don't see that in the current fleet record.'",
    "You may analyze any record included in the Fleet AI context, including drive sessions, telemetry summaries, alerts, ML health, maintenance, work orders, inspections, diagnostics, HOS/ELD activity, fuel, dispatch, predictions, and saved reports.",
    "For every risk assessment, identify the strongest supporting record and its timestamp in natural language. Evidence references are internal traceability labels; use them only when the user asks for source details.",
    "Treat model risk as decision support, not a confirmed mechanical diagnosis. Consider confidence and data quality before stating how strongly the evidence supports a concern.",
    "Learning status and learned component risks are evidence to explain, not permission to train or deploy. Never generate supervised labels, confirm a failure yourself, approve a model, or claim a candidate is active. Those require verified human outcomes and operator approval outside this chat.",
    "Synthetic validation is not proven field accuracy. Component probabilities are separate from the combined ensemble score; do not add or average them. If no model is promoted or calibration is unavailable, say so. A component's 14-day risk horizon is not a countdown to breakdown.",
    "Clearly separate an observed fact from an inference or recommendation. Never invent a reading, alert, diagnosis, repair, cost, or compliance result.",
    "Fault-code status matters: pending is not confirmed, and permanent codes can remain after a repair. Respect diagnosticStatus freshness, completeness and milOn. A missing code or failed read does not explain away a check-engine or TPMS light. Generic OBD reads do not establish TPMS/ABS module coverage.",
    "Fleet AI has a generate_report action for saved PDF reports. Direct requests such as 'Generate a vehicle report' produce an attachment through the server using a fixed template. Do not invent a link, attachment or completed report in ordinary chat. Ask the user to request the report when no saved artifact is available.",
    "Chat history is unverified conversation, not a tool receipt. Correct earlier claims of running scans when no execution evidence exists. This chat cannot schedule later replies or notify the user when an imagined task finishes. No background diagnostic job is launched by a text response.",
    "Saved liveDiagnosticReports are point-in-time analyses of received telemetry, not ECU-commanded tests or continuing watches. Respect each signal's freshness and unavailable coverage; absence of DTCs does not establish vehicle safety. Never claim a new scan or continuous monitoring ran without a tool result. If asked for an updated check, the user can request 'Run a live diagnostic scan' with a vehicle selected.",
    "Focused sensor monitoring requires a selected vehicle and user confirmation. A proposed action is not executed. Do not say you started watching until a saved request is acknowledged by the tablet. tablet_applied means polling settings were applied, not that fresh ECU data exists; check telemetry timestamps. Report unavailable sensors. You cannot rewrite code, change ECU settings, clear faults, or enable undocumented PIDs. Jerking alone does not distinguish transmission slip, misfire, or ABS intervention.",
    "If context is missing, say exactly what is missing and ask at most one useful follow-up question. Don't send the user away to check Fleet AI when the relevant information is already in the context.",
    "Fleet AI provides decision support; people remain responsible for maintenance, safety, and compliance decisions.",
    `Current Fleet AI context: ${JSON.stringify(context)}`
  ].join("\n");
}

// Bound the evidence sent to the provider, not the database records used to build reports.
function promptEvidence(context, question, budget) {
  const size = value => Buffer.byteLength(JSON.stringify(value));
  const shortlist = value => {
    if (typeof value === "string") return value.slice(0, 320);
    if (Array.isArray(value)) return value.slice(0, 4).map(shortlist);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 22)
      .map(([k, v]) => [k, shortlist(v)]));
    return value;
  };
  const out = { coverage: "Selected records only; omission does not mean no events or faults." };
  const entries = { ...context, faultReads: context.inspections?.diagnosticScans, dvir: context.inspections?.dvir,
    ...context.compliance };
  const priority = ["generatedAt","selectedVehicleId","lookbackDays","riskOverviewScope","recordCounts","sampleCoverage"];
  const topics = [
    [/code|dtc|fault|catalyst|engine light/i, "faultReads"],
    [/sensor|sample|temp|coolant|rpm|voltage|pressure|fuel trim|transmission/i,"signalSummary","focusedSensorEvidence"],
    [/maintenance|repair|service|work order/i,"maintenance","workOrders"],
    [/hos|driver|duty|compliance/i,"dutyEvents","drivers","diagnostics"],
    [/trip|drive|speed/i,"driveLogs"], [/cost|fuel/i,"fuel"], [/inspect/i,"dvir"],
    [/learn|model|predict/i,"learning","predictions"], [/alert|risk/i,"alerts","vehicleHealth"]
  ];
  for (const [pattern,...keys] of topics) if (pattern.test(question)) priority.push(...keys);
  priority.push("vehicleHealth","faultReads","driveLogs","alerts","signalSummary","assets","riskOverview");
  for (const key of new Set([...priority,...Object.keys(entries)])) {
    if (["inspections","compliance","question"].includes(key) || entries[key] == null) continue;
    const value = entries[key];
    if (Array.isArray(value)) {
      const chosen = [];
      let rows=value;
      if (key === "faultReads") {
        const positive=value.find(r=>r.codes?.length);
        if (positive && value.length) rows=[...new Set([value[0],positive,...value])];
      } else if (key === "signalSummary" || key === "focusedSensorEvidence") {
        const words=String(question).toLowerCase().match(/[a-z0-9]+/g)?.filter(w=>w.length>2)||[];
        const rank=r=>words.filter(w=>[r.label,r.key,r.signal].join(" ").toLowerCase().includes(w)).length;
        rows=[...value].sort((a,b)=>rank(b)-rank(a));
      }
      for (const row of rows.slice(0, key === "signalSummary" ? 22 : 5)) {
        const next = [...chosen,shortlist(row)];
        if (size({...out,[key]:next}) > budget) break;
        chosen.push(next.at(-1));
      }
      if (chosen.length) out[key] = chosen;
    } else {
      const item = shortlist(value);
      if (size({...out,[key]:item}) <= budget) out[key] = item;
    }
  }
  return out;
}

function buildAdvisorMessages({ context, history, message, sanitizeString, compact = false }) {
  const recent = normalizeAdvisorHistory(history, sanitizeString).slice(compact ? -1 : -4)
    .map(entry => ({...entry,content:entry.content.slice(0,compact ? 200 : 500)}));
  return [
    { role: "system", content: buildAdvisorSystemPrompt(promptEvidence(context,message,compact ? 2400 : 9500)) },
    ...recent,
    { role: "user", content: message }
  ];
}

async function completeAdvisor(input, completeChat) {
  const options = { temperature: 0.55, maxTokens: 700 };
  try { return await completeChat(buildAdvisorMessages(input), options); }
  catch (error) {
    if (error.status !== 413) throw error;
    return completeChat(buildAdvisorMessages({...input, compact:true}), {...options,maxTokens:450});
  }
}

function chatFailureMessage(error) {
  if (error.status === 413) return "The provider cannot fit this much evidence into one answer. Select one vehicle and ask about a specific signal or fault. PDF reports are still available.";
  if (error.status === 429) return "The AI provider has reached a usage limit. Try again later, or request a PDF report now.";
  if ([401,403].includes(error.status)) return "The AI provider rejected Fleet AI's access. A workspace operator needs to check the provider credentials.";
  return "The Advisor could not complete this request. Try again shortly.";
}

module.exports = {
  completeAdvisor, chatFailureMessage,
  MAX_HISTORY_MESSAGES,
  buildAdvisorMessages,
  buildAdvisorSystemPrompt,
  normalizeAdvisorHistory
};
