// Legacy compatibility wrapper.
// Canonical employee login client lives at /public/js/employee-login.js.
// Keep this file as a thin forwarder so older references do not drift into a second auth implementation.
(function loadCanonicalEmployeeLoginClient() {
  if (typeof document === "undefined") return;
  if (document.querySelector('script[data-fleetai-employee-login="canonical"]')) return;
  const script = document.createElement("script");
  script.src = "/public/js/employee-login.js";
  script.defer = true;
  script.dataset.fleetaiEmployeeLogin = "canonical";
  document.head.appendChild(script);
})();
