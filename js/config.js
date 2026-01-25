(() => {
  const stored = (() => {
    try {
      return localStorage.getItem("fleetai.apiBase") || "";
    } catch (e) {
      return "";
    }
  })();
  const injected = window.FLEETAI_API_BASE_URL || window.__FLEETAI_API_BASE_URL__ || window.FLEETAI_API_BASE || "";
  const base = String(injected || stored || "").trim().replace(/\/+$/, "");
  window.API_BASE_URL = base;
  window.FLEETAI_API_BASE_URL = base;
  window.apiUrl = (path) => {
    const raw = String(path || "");
    if (!raw) return base || "";
    if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
    if (!base) return raw.startsWith("/") ? raw : `/${raw}`;
    if (raw.startsWith("/")) return `${base}${raw}`;
    return `${base}/${raw}`;
  };
})();
