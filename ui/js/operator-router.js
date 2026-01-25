/**
 * Operator dashboard router
 * - Hash based routing with event delegation
 * - Hides overlays when inactive so nav remains clickable
 * - Fallback render when renderRoute is unavailable
 *
 * Quick checklist:
 * 1) Nav click updates hash and switches panels
 * 2) Refresh with #route shows that view
 * 3) Back/forward works (hashchange listener)
 * 4) No overlay blocks clicks when hidden
 */
(function () {
  const DEBUG_UI = false;
  const ROUTES = [
    "dashboard",
    "telemetry",
    "telemetry-history",
    "fuel-events",
    "health-risk",
    "dtc-history",
    "alerts",
    "safety",
    "compliance",
    "gps",
    "cameras",
    "advisor",
    "reports",
    "maintenance",
    "maintenance-logs",
    "vehicles",
    "drivers",
    "pairing",
    "addons",
    "settings",
  ];
  const FALLBACK = "dashboard";

  function log(...args) {
    if (DEBUG_UI) console.log("[nav]", ...args);
  }

  function normalize(route) {
    if (!route) return FALLBACK;
    const r = route.replace(/^#\/?/, "").split("?")[0].trim().toLowerCase();
    return r || FALLBACK;
  }

  function hideOverlays() {
    document.querySelectorAll(".overlay").forEach((el) => {
      const hidden =
        el.classList.contains("hide") ||
        el.getAttribute("aria-hidden") === "true";
      if (hidden) {
        el.style.pointerEvents = "none";
        el.style.display = "none";
        el.setAttribute("aria-hidden", "true");
      } else if (el.style.display === "none") {
        // ensure overlays that should be visible can recover after a hide
        el.style.display = "";
        el.style.pointerEvents = "auto";
        el.removeAttribute("aria-hidden");
      }
    });
  }

  function fallbackRender(route) {
    ROUTES.forEach((r) => {
      const panel = document.getElementById(`view-${r}`);
      if (!panel) return;
      if (r === route) {
        panel.classList.remove("hide");
      } else {
        panel.classList.add("hide");
      }
    });
    document.querySelectorAll("[data-route]").forEach((btn) => {
      const r = (btn.dataset.route || "").toLowerCase();
      btn.classList.toggle("active", r === route);
    });
  }

  function render(route) {
    const r = ROUTES.includes(route) ? route : FALLBACK;
    try {
      if (typeof renderRoute === "function") {
        renderRoute(r);
      } else {
        fallbackRender(r);
      }
    } catch (err) {
      console.error("[nav] render error", err);
      fallbackRender(r);
    }
    hideOverlays();
  }

  function navigate(route) {
    const r = normalize(route);
    const current = normalize(window.location.hash || "");
    if (current !== r) {
      window.location.hash = `#${r}`;
    } else {
      render(r);
    }
  }

  function onHashChange() {
    render(normalize(window.location.hash || ""));
  }

  function installNavDelegation() {
    const navRoot =
      document.querySelector(".nav") ||
      document.querySelector("#nav") ||
      document.querySelector("nav") ||
      document.body;

    navRoot.addEventListener(
      "click",
      (e) => {
        const btn = e.target.closest("[data-route]");
        const anchor = e.target.closest("a[href^='#']");
        if (!btn && !anchor) return;
        const route = btn
          ? btn.dataset.route
          : (anchor.getAttribute("href") || "")
              .replace(/^#\/?/, "")
              .split("?")[0];
        if (!route) return;
        e.preventDefault();
        e.stopPropagation();
        navigate(route);
      },
      true
    );
    log("Nav delegation installed on", navRoot);
  }

  function boot() {
    hideOverlays();
    installNavDelegation();
    window.addEventListener("hashchange", onHashChange);
    onHashChange();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
