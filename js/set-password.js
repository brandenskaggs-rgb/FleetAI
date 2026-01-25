function showSetPasswordMessage(message, ok) {
  const el = document.getElementById("setPasswordMessage");
  if (!el) return;
  el.style.display = "block";
  el.textContent = message;
  el.style.borderColor = ok ? "var(--primary)" : "var(--bad)";
}

function clearSetPasswordMessage() {
  const el = document.getElementById("setPasswordMessage");
  if (!el) return;
  el.style.display = "none";
  el.textContent = "";
}

function resolveApiUrl(path) {
  if (typeof window.resolveApiUrl === "function") return window.resolveApiUrl(path);
  if (typeof window.apiUrl === "function") return window.apiUrl(path);
  const base = window.__FLEETAI__?.apiBase || "";
  if (!base) return path;
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return path.startsWith("/") ? `${base}${path}` : `${base}/${path}`;
}

function updateDebug(partial) {
  const endpointEl = document.getElementById("setPwdDbgEndpoint");
  const statusEl = document.getElementById("setPwdDbgStatus");
  const errorEl = document.getElementById("setPwdDbgError");
  const rawEl = document.getElementById("setPwdDbgRaw");
  if (!partial) partial = {};
  if (endpointEl && partial.endpoint !== undefined) endpointEl.textContent = partial.endpoint || "--";
  if (statusEl && partial.status !== undefined) statusEl.textContent = partial.status || "--";
  if (errorEl && partial.error !== undefined) errorEl.textContent = partial.error || "--";
  if (rawEl && partial.raw !== undefined) rawEl.textContent = partial.raw || "--";
}

async function safeJson(res) {
  const text = await res.text();
  try {
    return { parsed: true, json: text ? JSON.parse(text) : {}, text };
  } catch (err) {
    return { parsed: false, json: null, text };
  }
}

function getQueryParam(name) {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get(name) || "";
  } catch (e) {
    return "";
  }
}

function validateSetPasswordForm() {
  const token = getQueryParam("token") || sessionStorage.getItem("fleetai_first_login_token") || document.getElementById("setPasswordToken")?.value || "";
  const next = document.getElementById("setPasswordNew")?.value || "";
  const confirm = document.getElementById("setPasswordConfirm")?.value || "";
  const btn = document.getElementById("setPasswordBtn");
  if (!btn) return;
  const valid = token.length > 0 && next.length >= 10 && next === confirm;
  btn.disabled = !valid;
}

async function submitSetPassword() {
  const token = getQueryParam("token") || sessionStorage.getItem("fleetai_first_login_token") || document.getElementById("setPasswordToken")?.value || "";
  const next = document.getElementById("setPasswordNew")?.value || "";
  const confirm = document.getElementById("setPasswordConfirm")?.value || "";
  const btn = document.getElementById("setPasswordBtn");
  clearSetPasswordMessage();
  if (!token || !next || !confirm) {
    showSetPasswordMessage("Token, new, and confirm password are required.", false);
    return;
  }
  if (next.length < 10) {
    showSetPasswordMessage("Password must be at least 10 characters.", false);
    return;
  }
  if (next !== confirm) {
    showSetPasswordMessage("Passwords do not match.", false);
    return;
  }
  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Saving...";
    }
    const endpoint = "/api/auth/set-password";
    updateDebug({ endpoint, status: "sending", error: "--", raw: "--" });
    const res = await fetch(resolveApiUrl(endpoint), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ token, newPassword: next })
    });
    updateDebug({ status: String(res.status) });
    const parsed = await safeJson(res);
    if (!parsed.parsed) {
      const raw = (parsed.text || "").slice(0, 200);
      updateDebug({ error: "non_json_response", raw });
      showSetPasswordMessage("Server returned non-JSON. See debug.", false);
      return;
    }
    const data = parsed.json || {};
    updateDebug({ raw: (parsed.text || "").slice(0, 200) });
    if (!res.ok || data.ok === false) {
      const msg = data.message || data.error || "Unable to update password.";
      showSetPasswordMessage(msg, false);
      updateDebug({ error: msg });
      return;
    }
    try { sessionStorage.removeItem("fleetai_first_login_token"); } catch (e) {}
    const role = getQueryParam("type") || sessionStorage.getItem("fleetai_first_login_role") || "customer";
    showSetPasswordMessage("Password updated. Redirecting to login...", true);
    setTimeout(() => {
      window.location.href = role === "employee" ? "/employee-login.html" : "/customer-login.html";
    }, 800);
  } catch (err) {
    const msg = err && err.message ? err.message : "Update failed. Try again.";
    updateDebug({ error: msg });
    showSetPasswordMessage(msg, false);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Save password";
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  validateSetPasswordForm();
  document.querySelectorAll("input").forEach((el) => {
    el.addEventListener("input", validateSetPasswordForm);
  });
  const btn = document.getElementById("setPasswordBtn");
  if (btn) btn.addEventListener("click", submitSetPassword);
  // Prefill email/token if stored
  const email = getQueryParam("email") || sessionStorage.getItem("fleetai_first_login_email") || "";
  const emailEl = document.getElementById("setPasswordEmail");
  if (emailEl && !emailEl.value) emailEl.value = email;
  const token = getQueryParam("token") || sessionStorage.getItem("fleetai_first_login_token") || "";
  const tokenEl = document.getElementById("setPasswordToken");
  if (tokenEl && !tokenEl.value) tokenEl.value = token;
  validateSetPasswordForm();
});
