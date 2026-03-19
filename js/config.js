(() => {
  function normalizeBase(value) {
    if (!value) return "";
    try {
      const parsed = new URL(String(value), window.location.origin);
      return parsed.origin;
    } catch (e) {
      return String(value).trim().replace(/\/+$/, "");
    }
  }

  const stored = (() => {
    try {
      return localStorage.getItem("fleetai.apiBase") || "";
    } catch (e) {
      return "";
    }
  })();
  const injected = window.FLEETAI_API_BASE_URL || window.__FLEETAI_API_BASE_URL__ || window.FLEETAI_API_BASE || "";
  const currentOrigin = window.location.origin;
  let base = normalizeBase(injected || stored || "");
  if (!injected && stored) {
    try {
      const storedUrl = new URL(base);
      const storedOrigin = storedUrl.origin;
      if (storedOrigin !== currentOrigin) {
        base = currentOrigin;
        try { localStorage.setItem("fleetai.apiBase", base); } catch (e) {}
      }
    } catch (e) {
      base = currentOrigin;
      try { localStorage.setItem("fleetai.apiBase", base); } catch (err) {}
    }
  }
  if (!base) base = currentOrigin;
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
