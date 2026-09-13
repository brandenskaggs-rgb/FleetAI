(() => {
  "use strict";
  let submitting = false;
  let completed = false;
  let setupInvalid = false;
  const storageKeys = ["fleetai_first_login_token", "fleetai_first_login_email", "fleetai_first_login_role"];
  const get = (id) => document.getElementById(id);

  function stored(key) {
    try { return sessionStorage.getItem(key) || ""; } catch (_) { return ""; }
  }
  function clearSetup() {
    for (const key of storageKeys) {
      try { sessionStorage.removeItem(key); } catch (_) { /* Storage can be blocked. */ }
    }
  }
  function loginPath() {
    return stored(storageKeys[2]) === "employee" ? "/employee-login.html" : "/customer-login.html";
  }
  function message(text, ok = false) {
    const el = get("setPasswordMessage");
    if (!el) return;
    el.hidden = false;
    el.style.display = "block";
    el.textContent = text;
    el.style.color = ok ? "var(--text)" : "var(--bad)";
  }
  function recoveryLink() {
    const link = get("setPasswordRetry");
    if (link) { link.href = loginPath(); link.hidden = false; }
  }
  function showRecovery(text) {
    setupInvalid = true;
    message(text);
    recoveryLink();
  }
  function validate() {
    const next = get("setPasswordNew")?.value || "";
    const confirm = get("setPasswordConfirm")?.value || "";
    const btn = get("setPasswordBtn");
    if (btn) btn.disabled = submitting || completed || setupInvalid || !stored(storageKeys[0]) || next.length < 10 || next !== confirm;
  }
  // First-login tokens deliberately stay in this tab, never URLs or localStorage.
  function destination(data) {
    const role = data.user?.role || data.session?.user?.role;
    const employeeRoles = ["SUPER_ADMIN", "ADMIN", "EMPLOYEE", "SUPPORT", "SALES"];
    const employee = role ? employeeRoles.includes(role) : stored(storageKeys[2]) === "employee";
    if (employee) return "/employee-console.html";
    const fallback = "/ui/fleetai-dashboard.html";
    try {
      const requested = new URLSearchParams(window.location.search).get("returnTo");
      if (!requested) return fallback;
      const url = new URL(requested, window.location.origin);
      return url.origin === window.location.origin && url.pathname === fallback
        ? `${url.pathname}${url.search}${url.hash}` : fallback;
    } catch (_) { return fallback; }
  }
  async function submit(event) {
    event?.preventDefault();
    if (submitting || completed || setupInvalid) return;
    const token = stored(storageKeys[0]);
    const next = get("setPasswordNew")?.value || "";
    const confirm = get("setPasswordConfirm")?.value || "";
    if (!token) {
      showRecovery("This setup link needs a fresh sign-in. Sign in with your temporary password and finish setup in that same tab.");
      validate();
      return;
    }
    if (next.length < 10 || next !== confirm) {
      message(next.length < 10 ? "Use at least 10 characters." : "The passwords do not match.");
      validate();
      return;
    }
    submitting = true;
    validate();
    const btn = get("setPasswordBtn");
    if (btn) btn.textContent = "Saving...";
    message("Saving your password...", true);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch("/api/auth/set-password", {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "include", signal: controller.signal,
        body: JSON.stringify({ token, newPassword: next })
      });
      let data;
      try { data = await res.json(); } catch (error) {
        if (controller.signal.aborted) throw error;
        throw new Error("INVALID_RESPONSE");
      }
      if (!res.ok || data?.ok !== true) {
        if ([400, 401, 403, 409].includes(res.status)) {
          showRecovery("Your setup session is expired or no longer valid. Sign in again to continue. If a previous save completed, use your new password.");
        } else if (res.status === 429) {
          message("Too many attempts. Wait a few minutes before trying again.");
        } else {
          message("The server could not finish setup. Try signing in with your new password before retrying the save.");
          recoveryLink();
        }
        return;
      }
      const target = destination(data);
      completed = true;
      clearSetup();
      get("setPasswordNew").value = "";
      get("setPasswordConfirm").value = "";
      message("Password saved. Opening your workspace...", true);
      window.location.replace(target);
    } catch (error) {
      message(controller.signal.aborted
        ? "The save took too long. It may have completed: sign in with your new password first. If it did not, sign in with your temporary password to restart setup."
        : "We could not confirm the save. Check your connection, then try signing in with your new password before restarting setup.");
      recoveryLink();
    } finally {
      clearTimeout(timer);
      submitting = false;
      if (btn) btn.textContent = completed ? "Password saved" : "Save password";
      validate();
    }
  }
  document.addEventListener("DOMContentLoaded", () => {
    get("setPasswordForm")?.addEventListener("submit", submit);
    ["setPasswordNew", "setPasswordConfirm"].forEach((id) => get(id)?.addEventListener("input", validate));
    const back = get("setPasswordBack");
    if (back) {
      back.href = loginPath();
      back.addEventListener("click", clearSetup);
    }
    if (!stored(storageKeys[0])) {
      showRecovery("This setup link needs a fresh sign-in. Sign in with your temporary password and finish setup in that same tab.");
    }
    validate();
  });
})();
