(function(){
  function $(id){ return document.getElementById(id); }

  const ENDPOINTS = {
    health: "/api/pairing/health",
    active: "/api/pairing/active",
    generate: "/api/pairing/generate",
    expire: "/api/pairing/expire"
  };

  function setDebug(partial){
    const map = {
      vehicleId: "pairingDebugVehicle",
      driverId: "pairingDebugDriver",
      endpoint: "pairingDebugEndpoint",
      status: "pairingDebugStatus",
      error: "pairingDebugError",
      conflict: "pairingDebugConflict",
      code: "pairingDebugCode",
      response: "pairingDebugResponse"
    };
    Object.keys(map).forEach((key) => {
      if (partial[key] === undefined) return;
      const el = $(map[key]);
      if (el) el.textContent = partial[key] || "--";
    });
  }

  function showError(msg){
    const err = $("pairError");
    if(!err) return;
    err.textContent = msg;
    err.style.display = "block";
  }

  function clearError(){
    const err = $("pairError");
    if(err){
      err.textContent = "";
      err.style.display = "none";
    }
  }

  function renderPairing(pairing){
    const codeEl = $("pairCodeValue");
    const expEl = $("pairExpiresValue");
    const pinEl = $("pairDriverPinValue");
    const pinExpEl = $("pairPinExpiresValue");
    const code = pairing.pairingCode || pairing.pairCode || pairing.code || "--";
    if(codeEl) codeEl.textContent = `Code: ${code}`;
    if(expEl) expEl.textContent = `Expires in ${formatCountdown(pairing.expiresAt)}`;
    if(pinEl) pinEl.textContent = `Driver PIN: ${pairing.driverPin || "--"}`;
    if(pinExpEl) pinExpEl.textContent = `PIN expires in ${formatCountdown(pairing.pinExpiresAt || pairing.expiresAt)}`;
  }

  function formatCountdown(iso){
    if(!iso) return "--:--";
    const diff = new Date(iso).getTime() - Date.now();
    if(!Number.isFinite(diff) || diff <= 0) return "00:00";
    const mins = Math.floor(diff / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  async function safeJson(res){
    const text = await res.text();
    try {
      return { ok: true, data: JSON.parse(text), raw: text };
    } catch (err) {
      return { ok: false, data: null, raw: text };
    }
  }

  async function fetchJson(url, options){
    const res = await fetch(url, {
      method: options?.method || "GET",
      headers: Object.assign({ "Content-Type": "application/json" }, options?.headers || {}),
      credentials: "include",
      body: options?.body ? JSON.stringify(options.body) : undefined
    });
    const parsed = await safeJson(res);
    return { res, parsed };
  }

  async function refreshActive(){
    const table = $("claimStatusTableBody");
    const empty = $("claimStatusEmpty");
    if(!table) return;
    const { res, parsed } = await fetchJson(ENDPOINTS.active);
    if(!parsed.ok || !res.ok){
      setDebug({ error: `active_${res.status}` });
      return;
    }
    const list = parsed.data?.pairings || [];
    table.innerHTML = list.map((p) => `
      <tr>
        <td>${p.vehicleId || "--"}</td>
        <td>${p.driverId || "--"}</td>
        <td>${p.deviceLabel || "--"}</td>
        <td>${p.lastSeen || p.claimedAt || "--"}</td>
        <td>${p.status || "active"}</td>
      </tr>
    `).join("");
    if(empty) empty.style.display = list.length ? "none" : "block";
  }

  async function generatePairCode(replaceActive){
    const vehicleId = $("pairVehicleSelect")?.value || "";
    const driverId = $("pairDriverSelect")?.value || "";
    const btn = $("btnGeneratePairCode");
    setDebug({
      vehicleId,
      driverId,
      endpoint: ENDPOINTS.generate,
      status: "REQUESTING",
      error: "--",
      conflict: "--",
      code: "--",
      response: "--"
    });
    clearError();
    if(!vehicleId || !driverId){
      showError("Select a vehicle and driver.");
      setDebug({ error: "missing_vehicle_or_driver" });
      return;
    }
    if(btn){
      btn.disabled = true;
      btn.textContent = "Generating...";
    }
    try{
      const { res, parsed } = await fetchJson(ENDPOINTS.generate, {
        method: "POST",
        body: { vehicleId, driverId, replaceActive: !!replaceActive }
      });
      setDebug({ status: String(res.status), response: parsed.raw?.slice(0, 200) || "--" });
      if(!parsed.ok){
        showError("Server returned non-JSON response.");
        setDebug({ error: "non_json_response" });
        return;
      }
      const data = parsed.data || {};
      if(res.status === 409 && data.error === "ACTIVE_PAIRING"){
        setDebug({ conflict: data.error });
        showConflict(data.activePairing);
        return;
      }
      if(!res.ok || !data.ok){
        const msg = data.message || data.error || "Pairing failed.";
        showError(msg);
        setDebug({ error: msg });
        return;
      }
      const pairing = data.pairing || data;
      const code = pairing.pairingCode || pairing.pairCode || pairing.code || "--";
      setDebug({ code });
      renderPairing(pairing);
      await refreshActive();
    } catch (err) {
      const msg = err && err.message ? err.message : "request_failed";
      showError(msg);
      setDebug({ error: msg });
    } finally {
      if(btn){
        btn.disabled = false;
        btn.textContent = "Generate Pair Code";
      }
    }
  }

  function showConflict(activePairing){
    const box = $("pairConflict");
    const detail = $("pairConflictDetail");
    if(!box || !detail) return;
    const code = activePairing?.pairingCode || activePairing?.pairCode || activePairing?.code || "--";
    detail.textContent = `Active pairing for vehicle ${activePairing?.vehicleId || "--"} / driver ${activePairing?.driverId || "--"} (code ${code})`;
    box.style.display = "block";
    box.dataset.pairId = activePairing?.id || "";
  }

  function hideConflict(){
    const box = $("pairConflict");
    if(box) box.style.display = "none";
  }

  async function expireAndRegenerate(){
    const vehicleId = $("pairVehicleSelect")?.value || "";
    const driverId = $("pairDriverSelect")?.value || "";
    const box = $("pairConflict");
    const pairingId = box?.dataset?.pairId || "";
    setDebug({ endpoint: ENDPOINTS.expire, status: "REQUESTING", error: "--" });
    await fetchJson(ENDPOINTS.expire, {
      method: "POST",
      body: pairingId ? { pairingId } : { vehicleId, driverId }
    });
    hideConflict();
    await generatePairCode(true);
  }

  async function pingHealth(){
    setDebug({ endpoint: ENDPOINTS.health, status: "REQUESTING", error: "--" });
    const { res, parsed } = await fetchJson(ENDPOINTS.health);
    setDebug({ status: String(res.status), response: parsed.raw?.slice(0, 200) || "--" });
    if(!parsed.ok || !res.ok){
      setDebug({ error: "health_failed" });
    } else {
      setDebug({ error: "--" });
    }
  }

  function init(){
    try{
      const btn = $("btnGeneratePairCode");
      if(btn){
        btn.addEventListener("click", () => {
          setDebug({ status: "clicked" });
          generatePairCode(false);
        });
      }
      const ping = $("pairPing");
      if(ping) ping.addEventListener("click", pingHealth);
      const useExisting = $("pairUseExisting");
      if(useExisting) useExisting.addEventListener("click", () => hideConflict());
      const expire = $("pairExpireGenerate");
      if(expire) expire.addEventListener("click", expireAndRegenerate);
      const replace = $("pairReplaceGenerate");
      if(replace) replace.addEventListener("click", () => generatePairCode(true));
      refreshActive();
    } catch (err) {
      const msg = err && err.message ? err.message : "pairing_init_failed";
      showError(msg);
      setDebug({ error: msg });
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
