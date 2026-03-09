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

  function getApiBase() {
    try {
      const params = new URLSearchParams(window.location.search);
      const override = params.get("apiBase");
      if (override) {
        const normalized = normalizeBase(override);
        localStorage.setItem("fleetai.apiBase", normalized);
        return normalized;
      }
    } catch (e) {}
    const currentOrigin = window.location.origin;
    const currentHost = window.location.hostname.toLowerCase();
    try {
      const stored = localStorage.getItem("fleetai.apiBase");
      if (stored) {
        const normalized = normalizeBase(stored);
        try {
          const storedUrl = new URL(normalized);
          if (storedUrl.hostname.toLowerCase() !== currentHost) {
            localStorage.setItem("fleetai.apiBase", currentOrigin);
            return currentOrigin;
          }
        } catch (e) {}
        return normalized;
      }
    } catch (e) {}
    if (window.__FLEETAI__ && window.__FLEETAI__.apiBase) {
      return normalizeBase(window.__FLEETAI__.apiBase);
    }
    return currentOrigin;
  }

  function resolveApiUrl(path) {
    if (!path) return getApiBase();
    if (path.startsWith("http://") || path.startsWith("https://")) return path;
    const base = getApiBase().replace(/\/+$/, "");
    const suffix = path.startsWith("/") ? path : `/${path}`;
    return `${base}${suffix}`;
  }

  window.getApiBase = getApiBase;
  window.resolveApiUrl = resolveApiUrl;
  window.apiUrl = resolveApiUrl;
})();
