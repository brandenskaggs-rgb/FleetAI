/**
 * Fleet AI Partner Widget
 * Drop-in embeddable dashboard for partners to show live vehicle health.
 *
 * Usage:
 *   <div id="fleetai-widget" data-vehicle="TRUCK-001"></div>
 *   <script src="https://fleetaiops.com/embed/fleet-widget.js"
 *           data-ticket-endpoint="/fleet-ai/stream-ticket"
 *           data-base-url="https://fleetaiops.com"></script>
 *
 * The widget connects to the SSE stream and updates in real time as new
 * telemetry comes in. No polling required.
 */
(function () {
  const script = document.currentScript;
  const BASE_URL = (script?.dataset?.baseUrl || "https://fleetaiops.com").replace(/\/$/, "");
  const TICKET_ENDPOINT = script?.dataset?.ticketEndpoint || "";
  const INITIAL_STREAM_TICKET = script?.dataset?.streamTicket || "";
  const RUL_ENDPOINT = script?.dataset?.rulEndpoint || "";
  let initialTicketConsumed = false;

  const RISK_LABELS = {
    failure_imminent: { label: "Failure Imminent", color: "#e53e3e" },
    maintenance_soon: { label: "Maintenance Soon", color: "#d97706" },
    monitor_closely:  { label: "Monitor Closely",  color: "#ca8a04" },
    healthy:          { label: "Healthy",           color: "#16a34a" },
    insufficient_data:{ label: "Calibrating",       color: "#6b7280" },
  };

  const URGENCY_COLOR = { critical: "#e53e3e", high: "#d97706", moderate: "#ca8a04", low: "#16a34a", improving: "#16a34a", stable: "#6b7280" };

  function riskColor(prob) {
    if (prob == null) return "#6b7280";
    if (prob >= 0.75) return "#e53e3e";
    if (prob >= 0.50) return "#d97706";
    if (prob >= 0.35) return "#ca8a04";
    return "#16a34a";
  }

  function pct(prob) {
    return prob != null ? Math.round(prob * 100) : "--";
  }

  function buildCSS() {
    return `
      .fai-widget { font-family: system-ui, sans-serif; background: #0f1117; color: #e2e8f0; border-radius: 12px; padding: 20px; max-width: 480px; border: 1px solid #1e2533; }
      .fai-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
      .fai-logo { font-weight: 700; font-size: 13px; color: #60a5fa; letter-spacing: 0.05em; }
      .fai-vehicle { font-size: 18px; font-weight: 700; color: #f1f5f9; }
      .fai-badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 12px; font-weight: 600; color: #fff; }
      .fai-score-row { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; }
      .fai-score-ring { position: relative; width: 80px; height: 80px; flex-shrink: 0; }
      .fai-score-ring svg { transform: rotate(-90deg); }
      .fai-score-num { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 22px; font-weight: 800; }
      .fai-score-label { font-size: 9px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; }
      .fai-advisory { font-size: 13px; color: #cbd5e1; line-height: 1.5; }
      .fai-sensors { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 16px; }
      .fai-sensor { background: #1a1f2e; border-radius: 8px; padding: 10px 12px; }
      .fai-sensor-name { font-size: 10px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
      .fai-sensor-val { font-size: 16px; font-weight: 700; }
      .fai-sensor-bar { height: 3px; border-radius: 2px; background: #1e2533; margin-top: 6px; }
      .fai-sensor-fill { height: 100%; border-radius: 2px; transition: width 0.6s ease; }
      .fai-section-title { font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.08em; margin: 14px 0 8px; }
      .fai-component { background: #1a1f2e; border-radius: 8px; padding: 10px 12px; margin-bottom: 6px; }
      .fai-component-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
      .fai-component-name { font-size: 13px; font-weight: 600; }
      .fai-component-confidence { font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 10px; color: #fff; }
      .fai-component-evidence { font-size: 11px; color: #94a3b8; line-height: 1.5; }
      .fai-component-action { font-size: 11px; color: #60a5fa; margin-top: 4px; }
      .fai-component-cost { font-size: 10px; color: #64748b; margin-top: 2px; }
      .fai-rul { background: #1a1f2e; border-radius: 8px; padding: 12px; display: flex; align-items: center; gap: 12px; }
      .fai-rul-days { font-size: 28px; font-weight: 800; }
      .fai-rul-label { font-size: 11px; color: #94a3b8; }
      .fai-rul-rec { font-size: 12px; color: #cbd5e1; margin-top: 2px; }
      .fai-footer { font-size: 10px; color: #475569; text-align: right; margin-top: 12px; }
      .fai-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #16a34a; margin-right: 5px; animation: fai-pulse 2s infinite; }
      @keyframes fai-pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
      .fai-connecting { color: #64748b; font-size: 13px; padding: 20px; text-align: center; }
    `;
  }

  function renderSensorBar(risk) {
    const color = risk >= 70 ? "#e53e3e" : risk >= 30 ? "#d97706" : "#16a34a";
    return `<div class="fai-sensor-bar"><div class="fai-sensor-fill" style="width:${Math.min(100,risk)}%;background:${color}"></div></div>`;
  }

  function renderSensors(sensorRisks) {
    const SENSOR_LABELS = {
      coolantTemp: "Coolant", batteryVoltage: "Battery", rpm: "RPM",
      fuelRate: "Fuel Rate", oilTemp: "Oil Temp", dpfSootLoad: "DPF Soot",
      turboBoostKpa: "Turbo Boost", vibration: "Vibration"
    };
    const entries = Object.entries(sensorRisks || {})
      .filter(([k]) => SENSOR_LABELS[k])
      .sort(([,a],[,b]) => b - a)
      .slice(0, 6);
    if (!entries.length) return "";
    return `
      <div class="fai-section-title">Sensor Health</div>
      <div class="fai-sensors">
        ${entries.map(([k, v]) => `
          <div class="fai-sensor">
            <div class="fai-sensor-name">${SENSOR_LABELS[k] || k}</div>
            <div class="fai-sensor-val" style="color:${v>=70?"#e53e3e":v>=30?"#d97706":"#16a34a"}">${v}/100</div>
            ${renderSensorBar(v)}
          </div>
        `).join("")}
      </div>
    `;
  }

  function renderDiagnosis(diagnosis) {
    if (!diagnosis?.components?.length) return "";
    const top = diagnosis.components.slice(0, 3);
    return `
      <div class="fai-section-title">Component Diagnosis</div>
      ${top.map(c => {
        const conf = Math.round((c.confidence || 0) * 100);
        const color = conf >= 70 ? "#e53e3e" : conf >= 40 ? "#d97706" : "#ca8a04";
        return `
          <div class="fai-component">
            <div class="fai-component-header">
              <div class="fai-component-name">${c.component || c.part || "Unknown"}</div>
              <div class="fai-component-confidence" style="background:${color}">${conf}%</div>
            </div>
            <div class="fai-component-evidence">${(c.evidence || []).slice(0,2).join(" ")}</div>
            ${c.mechanic_action ? `<div class="fai-component-action">→ ${c.mechanic_action}</div>` : ""}
            ${c.estimated_cost ? `<div class="fai-component-cost">Est. part cost: ${c.estimated_cost}</div>` : ""}
          </div>
        `;
      }).join("")}
    `;
  }

  function renderRUL(rul) {
    if (!rul?.available) return "";
    const color = URGENCY_COLOR[rul.urgency] || "#6b7280";
    const days = rul.estimatedDaysToService;
    return `
      <div class="fai-section-title">Breakdown Timeline</div>
      <div class="fai-rul">
        <div style="color:${color}">
          <div class="fai-rul-days">${days != null ? days : "—"}</div>
          <div class="fai-rul-label">${days != null ? "days to service" : "stable"}</div>
        </div>
        <div>
          <div class="fai-rul-rec">${rul.recommendation || ""}</div>
          ${rul.subsystem ? `<div style="font-size:11px;color:#64748b;margin-top:4px">System: ${rul.subsystem}</div>` : ""}
        </div>
      </div>
    `;
  }

  function render(container, data, rul) {
    const prob = data.riskProbability;
    const pctVal = pct(prob);
    const color = riskColor(prob);
    const label = RISK_LABELS[data.prediction] || { label: data.prediction || "Unknown", color: "#6b7280" };
    const circumference = 2 * Math.PI * 32;
    const dash = circumference - (prob ?? 0) * circumference;

    container.innerHTML = `
      <style>${buildCSS()}</style>
      <div class="fai-widget">
        <div class="fai-header">
          <div>
            <div class="fai-logo">⚡ FLEET AI</div>
            <div class="fai-vehicle">${data.vehicleId || "Vehicle"}</div>
          </div>
          <span class="fai-badge" style="background:${label.color}">${label.label}</span>
        </div>

        <div class="fai-score-row">
          <div class="fai-score-ring">
            <svg width="80" height="80" viewBox="0 0 80 80">
              <circle cx="40" cy="40" r="32" fill="none" stroke="#1e2533" stroke-width="7"/>
              <circle cx="40" cy="40" r="32" fill="none" stroke="${color}" stroke-width="7"
                stroke-dasharray="${circumference}" stroke-dashoffset="${dash}"
                stroke-linecap="round" style="transition:stroke-dashoffset 0.8s ease"/>
            </svg>
            <div class="fai-score-num" style="color:${color}">
              ${pctVal}<span style="font-size:11px;font-weight:400">%</span>
              <span class="fai-score-label">risk</span>
            </div>
          </div>
          <div class="fai-advisory">${data.advisoryText || "No advisory available."}</div>
        </div>

        ${renderSensors(data.sensorRisks)}
        ${renderDiagnosis(data.diagnosis)}
        ${rul ? renderRUL(rul) : ""}

        <div class="fai-footer">
          <span class="fai-dot"></span>Live · Updated ${new Date(data.receivedAt || data.timestamp).toLocaleTimeString()}
        </div>
      </div>
    `;
  }

  async function fetchRUL(vehicleId) {
    if (!RUL_ENDPOINT) return null;
    try {
      const separator = RUL_ENDPOINT.includes("?") ? "&" : "?";
      const r = await fetch(`${RUL_ENDPOINT}${separator}vehicleId=${encodeURIComponent(vehicleId)}`, {
        credentials: "include",
        headers: { "Accept": "application/json" }
      });
      if (!r.ok) return null;
      return await r.json();
    } catch (_) { return null; }
  }

  async function getStreamTicket() {
    if (!initialTicketConsumed && INITIAL_STREAM_TICKET) {
      initialTicketConsumed = true;
      return INITIAL_STREAM_TICKET;
    }
    if (!TICKET_ENDPOINT) return "";
    const response = await fetch(TICKET_ENDPOINT, {
      method: "POST",
      credentials: "include",
      headers: { "Accept": "application/json" }
    });
    if (!response.ok) throw new Error("Stream ticket request failed");
    const payload = await response.json();
    return payload.ticket || payload.data?.ticket || "";
  }

  async function initWidget(container, vehicleId) {
    container.innerHTML = `<style>${buildCSS()}</style><div class="fai-connecting">⚡ Connecting to Fleet AI...</div>`;

    let rul = null;
    try {
      rul = await fetchRUL(vehicleId);
    } catch (_) {}

    let ticket = "";
    try {
      ticket = await getStreamTicket();
    } catch (_) {}
    if (!ticket) {
      container.innerHTML = `<style>${buildCSS()}</style><div class="fai-connecting">Secure stream ticket required.</div>`;
      return;
    }
    const streamUrl = `${BASE_URL}/api/partner/stream?vehicleId=${encodeURIComponent(vehicleId)}&streamTicket=${encodeURIComponent(ticket)}`;
    const es = new EventSource(streamUrl);

    es.addEventListener("snapshot", async (e) => {
      const data = JSON.parse(e.data);
      if (!rul) rul = await fetchRUL(vehicleId);
      render(container, data, rul);
    });

    es.onmessage = async (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.vehicleId === vehicleId || !data.vehicleId) {
          if (!rul) rul = await fetchRUL(vehicleId);
          render(container, data, rul);
        }
      } catch (_) {}
    };

    es.onerror = () => {
      setTimeout(() => initWidget(container, vehicleId), 5000);
      es.close();
    };
  }

  document.addEventListener("DOMContentLoaded", () => {
    const containers = document.querySelectorAll("[data-fleetai-vehicle], #fleetai-widget[data-vehicle]");
    for (const el of containers) {
      const vehicleId = el.dataset.fleetaiVehicle || el.dataset.vehicle;
      if (vehicleId && (TICKET_ENDPOINT || INITIAL_STREAM_TICKET)) initWidget(el, vehicleId);
    }
  });
})();
