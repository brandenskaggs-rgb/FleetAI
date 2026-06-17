function setupShowMessage(message, isError) {
  const el = document.getElementById("setupError");
  if (!el) return;
  if (!message) {
    el.style.display = "none";
    el.textContent = "";
    return;
  }
  el.style.display = "block";
  el.style.borderColor = isError ? "rgba(248,113,113,0.6)" : "rgba(37,99,235,0.3)";
  el.style.background = isError ? "rgba(248,113,113,0.12)" : "rgba(37,99,235,0.08)";
  el.textContent = message;
}

const _setupApiUrl = window.apiUrl || ((path) => path);

function setupSetStatus(message) {
  const el = document.getElementById("setupStatus");
  if (!el) return;
  el.textContent = message;
}

function setupDisableForm(disabled) {
  ["setupKey", "setupEmail", "setupPassword", "setupConfirm", "setupSubmit"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  });
}

async function setupCheckStatus() {
  try {
    const res = await fetch(_setupApiUrl("/api/admin/setup/status"));
    console.log("[setup] status response", res.status);
    const data = await res.json();
    if (!data.enabled) {
      setupDisableForm(true);
      const msg = data.reason || "Setup disabled.";
      setupSetStatus(msg);
      setupShowMessage(msg, true);
      return;
    }
    setupDisableForm(false);
    setupShowMessage("", false);
    setupSetStatus("Setup is available. Create the first Super Admin account.");
  } catch (err) {
    setupSetStatus("Setup status unavailable.");
    setupShowMessage("Setup status unavailable.", true);
  }
}

async function setupSubmit() {
  const setupKey = document.getElementById("setupKey")?.value || "";
  const email = document.getElementById("setupEmail")?.value || "";
  const password = document.getElementById("setupPassword")?.value || "";
  const confirmPassword = document.getElementById("setupConfirm")?.value || "";
  console.log("[setup] submit", { email, hasKey: !!setupKey });
  if (password !== confirmPassword) {
    setupShowMessage("Passwords do not match.", true);
    return;
  }
  try {
    const res = await fetch(_setupApiUrl("/api/admin/setup"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setupKey, email, password })
    });
    console.log("[setup] response status", res.status);
    const data = await res.json();
    if (!res.ok) {
      setupShowMessage(data.error || "Setup failed.", true);
      return;
    }
    setupShowMessage("Super Admin created. Setup is now disabled.", false);
    setTimeout(() => {
      window.location.href = "/employee-login.html";
    }, 1200);
  } catch (err) {
    setupShowMessage("Setup failed.", true);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  setupCheckStatus();
  const btn = document.getElementById("setupSubmit");
  if (btn) btn.addEventListener("click", setupSubmit);
});
