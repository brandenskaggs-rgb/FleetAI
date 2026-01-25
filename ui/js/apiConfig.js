(() => {
  function getApiBase() {
    try {
      const params = new URLSearchParams(window.location.search);
      const override = params.get("apiBase");
      if (override) {
        localStorage.setItem("fleetai.apiBase", override);
        return override;
      }
    } catch (e) {}
    try {
      const stored = localStorage.getItem("fleetai.apiBase");
      if (stored) return stored;
    } catch (e) {}
    if (window.__FLEETAI__ && window.__FLEETAI__.apiBase) return window.__FLEETAI__.apiBase;
    return window.location.origin;
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
