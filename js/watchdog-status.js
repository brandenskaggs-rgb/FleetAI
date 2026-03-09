(() => {
  function createPill() {
    const pill = document.createElement("div");
    pill.id = "watchdogPill";
    pill.style.position = "fixed";
    pill.style.top = "12px";
    pill.style.right = "12px";
    pill.style.zIndex = "9";
    pill.style.padding = "6px 10px";
    pill.style.borderRadius = "999px";
    pill.style.fontSize = "12px";
    pill.style.background = "#0f172a";
    pill.style.color = "#e2e8f0";
    pill.style.border = "1px solid #1f2937";
    pill.style.pointerEvents = "none";
    pill.textContent = "Health: --";
    document.body.appendChild(pill);
    return pill;
  }

  async function poll(pill) {
    try {
      const res = await fetch("/api/system/watchdog", { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const ok = Boolean(data?.checks?.health?.ok || data?.checks?.apiHealth?.ok);
      pill.style.background = ok ? "#0f3d2e" : "#3f1d1d";
      pill.textContent = `Health: ${ok ? "OK" : "ERR"}`;
    } catch (_) {
      pill.style.background = "#3f1d1d";
      pill.textContent = "Health: ERR";
    }
  }

  function boot() {
    const pill = createPill();
    poll(pill);
    setInterval(() => poll(pill), 5000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
