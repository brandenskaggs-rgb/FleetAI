"use strict";
(() => {
  const field = id => document.getElementById(id);
  const token = new URLSearchParams(location.search).get("token") || "";
  const submit = field("inviteSubmit");
  const form = field("inviteForm");
  let ready = false;
  const status = (text, success = false) => {
    const element = field("signupStatus");
    element.style.display = "block";
    element.style.color = success ? "var(--good)" : "var(--bad)";
    element.textContent = text;
  };
  async function loadInvite() {
    submit.disabled = true;
    if (!token) {
      field("inviteDetails").textContent = "Open the invitation link sent by your administrator.";
      status("An invitation is required to activate an account.");
      return;
    }
    try {
      const response = await fetch("/api/invites/" + encodeURIComponent(token), { cache: "no-store" });
      const result = await response.json();
      if (!response.ok || !result.data) throw new Error(result.error || "This invitation is unavailable or has expired.");
      const invite = result.data;
      field("inviteDetails").textContent = "Invitation for " + (invite.companyName || invite.orgName || invite.orgId || "your workspace") + ". Expires " + new Date(invite.expiresAt).toLocaleString() + ".";
      if (invite.email) field("inviteEmail").value = invite.email;
      ready = true;
      submit.disabled = false;
    } catch (error) {
      field("inviteDetails").textContent = "Ask your administrator for a new invitation if this link is no longer valid.";
      status(error.message || "Unable to check the invitation. Please try again.");
    }
  }
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!ready || submit.disabled || !form.reportValidity()) return;
    submit.disabled = true;
    submit.textContent = "Activating...";
    try {
      const response = await fetch("/api/invites/" + encodeURIComponent(token) + "/accept", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: field("inviteEmail").value.trim(), password: field("invitePassword").value })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Account activation failed. Check your invitation details.");
      ready = false;
      field("invitePassword").value = "";
      status("Account activated. Taking you to sign in.", true);
      const staff = ["SUPER_ADMIN", "EMPLOYEE", "ADMIN", "SUPPORT", "SALES"].includes(result.data?.role);
      setTimeout(() => { location.href = staff ? "/employee-login.html" : "/customer-login.html"; }, 1200);
    } catch (error) { status(error.message || "Unable to activate your account. Please try again."); }
    finally { submit.disabled = !ready; submit.textContent = ready ? "Activate account" : "Account activated"; }
  });
  loadInvite();
})();
