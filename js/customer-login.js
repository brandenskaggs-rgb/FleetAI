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

function resolveCustomerApiUrl(path) {
  if (typeof window.resolveApiUrl === "function") return window.resolveApiUrl(path);
  if (typeof window.apiUrl === "function") return window.apiUrl(path);
  const base = window.__FLEETAI__?.apiBase || "";
  if (!base) return path;
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return path.startsWith("/") ? `${base}${path}` : `${base}/${path}`;
}

function setCustomerDebug({ endpoint, status, error }) {
  const endpointEl = document.getElementById("customerDbgEndpoint");
  const statusEl = document.getElementById("customerDbgStatus");
  const errorEl = document.getElementById("customerDbgError");
  if (endpointEl && endpoint !== undefined) endpointEl.textContent = endpoint || "--";
  if (statusEl && status !== undefined) statusEl.textContent = status || "--";
  if (errorEl && error !== undefined) errorEl.textContent = error || "--";
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
        const token = data.setupToken;
        const type = "customer";
        window.location.href = `/set-password.html?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}&type=${type}`;
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
    if (data.session?.token) {
      try { localStorage.setItem("fleetai_customer_token", data.session.token); } catch (e) {}
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
    window.location.href = data.redirectTo || "/ui/fleetai-dashboard.html";
  } catch (err) {
    setCustomerDebug({ status: "ERR", error: err?.message || "request failed" });
    showCustomerLoginMessage("Login failed. Try again.", false);
  } finally {
    if (btn) btn.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
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
