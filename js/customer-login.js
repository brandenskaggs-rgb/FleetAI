function showCustomerLoginMessage(message, ok) {
  const el = document.getElementById("customerLoginMessage");
  if (!el) return;
  el.style.display = "block";
  el.textContent = message;
  el.style.borderColor = ok ? "var(--primary)" : "var(--bad)";
}

function clearCustomerLoginMessage() {
  const el = document.getElementById("customerLoginMessage");
  if (!el) return;
  el.style.display = "none";
  el.textContent = "";
}

async function verifyCustomerSession() {
  const sessionEndpoint = "/api/auth/customer/session";
  const meEndpoint = "/api/me";
  const sessionRes = await fetch(resolveCustomerApiUrl(sessionEndpoint), {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    headers: { "Accept": "application/json" }
  });
  if (!sessionRes.ok) return { ok: false, reason: `session ${sessionRes.status}` };
  const sessionData = await safeJson(sessionRes);
  if (!sessionData.okParse || !sessionData.data?.user?.email) return { ok: false, reason: "session shape" };

  const meRes = await fetch(resolveCustomerApiUrl(meEndpoint), {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    headers: { "Accept": "application/json" }
  });
  if (!meRes.ok) return { ok: false, reason: `me ${meRes.status}` };
  const meData = await safeJson(meRes);
  if (!meData.okParse || !meData.data?.user?.email) return { ok: false, reason: "me shape" };
  return { ok: true, session: sessionData.data, me: meData.data };
}

function resolveCustomerApiUrl(path) {
  if (typeof window.resolveApiUrl === "function") return window.resolveApiUrl(path);
  if (typeof window.apiUrl === "function") return window.apiUrl(path);
  const base = window.__FLEETAI__?.apiBase || "";
  if (!base) return path;
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return path.startsWith("/") ? `${base}${path}` : `${base}/${path}`;
}

const CUSTOMER_LOGIN_DEBUG = (() => {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("diag") === "1") return true;
    return localStorage.getItem("fleetai.debug") === "true";
  } catch (e) {
    return false;
  }
})();

function setCustomerDebug({ endpoint, status, error }) {
  const panelEl = document.getElementById("customerDebugPanel");
  if (panelEl) {
    panelEl.hidden = !CUSTOMER_LOGIN_DEBUG;
    panelEl.setAttribute("aria-hidden", CUSTOMER_LOGIN_DEBUG ? "false" : "true");
  }
  if (!CUSTOMER_LOGIN_DEBUG) return;
  const endpointEl = document.getElementById("customerDbgEndpoint");
  const statusEl = document.getElementById("customerDbgStatus");
  const errorEl = document.getElementById("customerDbgError");
  if (endpointEl && endpoint !== undefined) endpointEl.textContent = endpoint || "--";
  if (statusEl && status !== undefined) statusEl.textContent = status || "--";
  if (errorEl && error !== undefined) errorEl.textContent = error || "--";
  try {
    const previous = JSON.parse(sessionStorage.getItem("fleetai_customer_debug") || "{}");
    const next = {
      endpoint: endpoint !== undefined ? endpoint : (previous.endpoint || "--"),
      status: status !== undefined ? status : (previous.status || "--"),
      error: error !== undefined ? error : (previous.error || "--"),
      ts: Date.now()
    };
    sessionStorage.setItem("fleetai_customer_debug", JSON.stringify(next));
  } catch (e) {}
}

function restoreCustomerDebug() {
  if (!CUSTOMER_LOGIN_DEBUG) return;
  try {
    const raw = sessionStorage.getItem("fleetai_customer_debug");
    if (!raw) return;
    const data = JSON.parse(raw);
    const endpointEl = document.getElementById("customerDbgEndpoint");
    const statusEl = document.getElementById("customerDbgStatus");
    const errorEl = document.getElementById("customerDbgError");
    const panelEl = document.getElementById("customerDebugPanel");
    if (panelEl) {
      panelEl.hidden = false;
      panelEl.setAttribute("aria-hidden", "false");
    }
    if (endpointEl) endpointEl.textContent = data.endpoint || "--";
    if (statusEl) statusEl.textContent = data.status || "--";
    if (errorEl) errorEl.textContent = data.error || "--";
  } catch (e) {}
}

async function safeJson(res) {
  const text = await res.text();
  try {
    return { okParse: true, data: text ? JSON.parse(text) : {}, raw: text };
  } catch (err) {
    console.log("CUSTOMER_LOGIN: non-JSON response", text ? text.slice(0, 300) : "");
    return { okParse: false, data: null, raw: text };
  }
}

async function submitCustomerLogin() {
  const email = document.getElementById("customerEmail")?.value.trim() || "";
  const password = document.getElementById("customerPassword")?.value || "";
  const btn = document.getElementById("customerLoginBtn");
  clearCustomerLoginMessage();
  if (!email || !password) {
    showCustomerLoginMessage("Email and password are required.", false);
    return;
  }
  try {
    if (btn) btn.disabled = true;
    const endpoint = "/api/auth/customer/login";
    setCustomerDebug({ endpoint, status: "sending", error: "--" });
    const res = await fetch(resolveCustomerApiUrl(endpoint), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email, password })
    });
    setCustomerDebug({ status: String(res.status) });
    const parsed = await safeJson(res);
    if (!parsed.okParse) {
      setCustomerDebug({ error: "invalid json response" });
      showCustomerLoginMessage("Server returned non-JSON. Please retry.", false);
      return;
    }
    const data = parsed.data || {};
    if (!res.ok || data.ok === false) {
      const code = data.code || data.error;
      if (res.status === 409 && code === "PASSWORD_SETUP_REQUIRED" && data.setupToken) {
        try {
          sessionStorage.setItem("fleetai_first_login_token", data.setupToken);
          sessionStorage.setItem("fleetai_first_login_email", email);
          sessionStorage.setItem("fleetai_first_login_role", "customer");
        } catch (e) {}
        const hash = `#token=${encodeURIComponent(data.setupToken)}&email=${encodeURIComponent(email)}&role=customer`;
        window.location.href = `/set-password.html${hash}`;
        return;
      }
      if (code === "USER_NOT_FOUND") {
        setCustomerDebug({ error: "USER_NOT_FOUND" });
        showCustomerLoginMessage("User not found.", false);
        return;
      }
      if (code === "INVALID_CREDENTIALS") {
        setCustomerDebug({ error: "INVALID_CREDENTIALS" });
        showCustomerLoginMessage("Invalid credentials.", false);
        return;
      }
      setCustomerDebug({ error: code || "LOGIN_FAILED" });
      showCustomerLoginMessage("Login failed. Try again.", false);
      return;
    }
    // Browser auth is cookie-first for web flows. Do not persist session tokens in storage.
    const verified = await verifyCustomerSession();
    if (!verified.ok) {
      setCustomerDebug({ error: `session verify failed: ${verified.reason}` });
      showCustomerLoginMessage("Login succeeded, but Fleet AI could not verify the customer session after sign-in. Hard refresh once and try again.", false);
      return;
    }
    if (data.next && data.next.action === "SET_PASSWORD" && data.next.token) {
      try {
        sessionStorage.setItem("fleetai_first_login_token", data.next.token);
        sessionStorage.setItem("fleetai_first_login_email", email);
      } catch (e) {}
      showCustomerLoginMessage("First login requires setting a new password.", true);
      window.location.href = "/ui/settings/set-password.html";
      return;
    }
    const target = data.redirectTo || "/ui/fleetai-dashboard.html";
    const safeTarget = target.startsWith("http://") || target.startsWith("https://")
      ? target
      : `${window.location.origin}${target.startsWith("/") ? target : `/${target}`}`;
    window.location.href = safeTarget;
  } catch (err) {
    setCustomerDebug({ status: "ERR", error: err?.message || "request failed" });
    showCustomerLoginMessage("Login failed. Try again.", false);
  } finally {
    if (btn) btn.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  restoreCustomerDebug();
  setCustomerDebug({ endpoint: "/api/auth/customer/login", status: "--", error: "--" });
  const btn = document.getElementById("customerLoginBtn");
  if (btn) btn.addEventListener("click", submitCustomerLogin);
  const password = document.getElementById("customerPassword");
  if (password) {
    password.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submitCustomerLogin();
      }
    });
  }
});
