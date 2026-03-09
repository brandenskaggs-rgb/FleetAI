(() => {
  const EMPLOYEE_LOGIN_ENDPOINT = "/api/auth/employee/login";
  const EMPLOYEE_CONSOLE_URL = "/employee-console.html";
  const CUSTOMER_DASHBOARD_URL = "/ui/fleetai-dashboard.html";
  const LOGIN_DEBUG = (() => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get("diag") === "1") return true;
      return localStorage.getItem("fleetai.debug") === "true";
    } catch (e) {
      return false;
    }
  })();

  const form = document.getElementById("employeeLoginForm");
  const emailInput = document.getElementById("employeeEmail");
  const passwordInput = document.getElementById("employeePassword");
  const twofaInput = document.getElementById("employee2fa");
  const errorEl = document.getElementById("loginError");
  const dbgEndpoint = document.getElementById("dbgEndpoint");
  const dbgStatus = document.getElementById("dbgStatus");
  const dbgError = document.getElementById("dbgError");

  function setError(message) {
    if (!errorEl) return;
    if (!message) {
      errorEl.style.display = "none";
      errorEl.textContent = "";
      return;
    }
    errorEl.style.display = "block";
    errorEl.textContent = message;
  }

  function setDebug(endpoint, status, error) {
    if (dbgEndpoint) dbgEndpoint.textContent = endpoint || "--";
    if (dbgStatus) dbgStatus.textContent = status || "--";
    if (dbgError) dbgError.textContent = error || "--";
  }

  function logDebug() {
    if (!LOGIN_DEBUG) return;
    console.log.apply(console, ["EMP_LOGIN:"].concat(Array.from(arguments)));
  }

  function resolveRedirect(serverRedirect, role) {
    if (serverRedirect) return serverRedirect;
    if (role === "employee") return EMPLOYEE_CONSOLE_URL;
    return CUSTOMER_DASHBOARD_URL;
  }

  function resolveErrorMessage(data) {
    const code = data && (data.code || data.error);
    if (code === "USER_NOT_FOUND") return "User not found.";
    if (code === "INVALID_CREDENTIALS") return "Invalid credentials.";
    if (code === "ACCOUNT_LOCKED") return "Account locked. Contact admin.";
    return data && data.message ? data.message : "Login failed.";
  }

  async function handleSubmit(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
    }

    const payload = {
      email: emailInput ? emailInput.value.trim() : "",
      password: passwordInput ? passwordInput.value : "",
      twofa: twofaInput ? twofaInput.value.trim() : ""
    };

    logDebug("payload keys", Object.keys(payload).filter((k) => k !== "password"));
    setError("");
    setDebug(EMPLOYEE_LOGIN_ENDPOINT, "sending", "");

    if (!payload.email || !payload.password) {
      setError("Please enter your email and password.");
      setDebug(EMPLOYEE_LOGIN_ENDPOINT, "client", "missing fields");
      return;
    }

    try {
      const url = window.resolveApiUrl ? window.resolveApiUrl(EMPLOYEE_LOGIN_ENDPOINT) : EMPLOYEE_LOGIN_ENDPOINT;
      console.log(url)
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload)
      });

      setDebug(EMPLOYEE_LOGIN_ENDPOINT, String(res.status), "");
      logDebug("status", res.status);

      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : {};
      } catch (err) {
        logDebug("non-JSON response", text);
        setError("Login failed: invalid server response.");
        setDebug(EMPLOYEE_LOGIN_ENDPOINT, String(res.status), "invalid json");
        return;
      }

      if (res.status === 409 && data && data.code === "PASSWORD_SETUP_REQUIRED" && data.setupToken) {
        const token = data.setupToken;
        window.location.href = `/set-password.html?token=${encodeURIComponent(token)}&email=${encodeURIComponent(payload.email)}&type=employee`;
        return;
      }
      if (!res.ok || (data && data.ok === false)) {
        const message = resolveErrorMessage(data);
        setError(message);
        setDebug(EMPLOYEE_LOGIN_ENDPOINT, String(res.status), message);
        return;
      }

      if (data && data.token) {
        try {
          localStorage.setItem("fleetai_employee_token", data.token);
          localStorage.setItem("fleetai.employeeToken", data.token);
        } catch (err) {}
      }

      const resolvedRole = data && data.user && data.user.role ? data.user.role : "unknown";
      const redirectTo = resolveRedirect(data.redirect, resolvedRole);
      logDebug("resolved role", resolvedRole);
      logDebug("redirect target", redirectTo);
      window.location.href = redirectTo;
    } catch (err) {
      const message = err && err.message ? err.message : "Login failed.";
      setError(message);
      setDebug(EMPLOYEE_LOGIN_ENDPOINT, "ERR", message);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    setDebug(EMPLOYEE_LOGIN_ENDPOINT, "--", "--");
    if (form) {
      form.addEventListener("submit", handleSubmit, { capture: true });
      form.addEventListener("reset", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
      }, { capture: true });
    }
  });
})();
