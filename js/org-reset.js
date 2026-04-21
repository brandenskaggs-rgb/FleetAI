function showResetMessage(message, ok) {
  const el = document.getElementById("resetMessage");
  if (!el) return;
  el.style.display = "block";
  el.textContent = message;
  el.style.borderColor = ok ? "var(--primary)" : "var(--bad)";
}

function clearResetMessage() {
  const el = document.getElementById("resetMessage");
  if (!el) return;
  el.style.display = "none";
  el.textContent = "";
}

const apiUrl = window.apiUrl || ((path) => path);

async function submitReset() {
  const password = document.getElementById("resetPassword")?.value || "";
  const confirm = document.getElementById("resetPasswordConfirm")?.value || "";
  clearResetMessage();
  if (!password || !confirm) {
    showResetMessage("Enter and confirm your new password.", false);
    return;
  }
  if (password.length < 10) {
    showResetMessage("Password must be at least 10 characters.", false);
    return;
  }
  if (password !== confirm) {
    showResetMessage("Passwords do not match.", false);
    return;
  }
  try {
    const res = await fetch(apiUrl("/api/auth/org/reset-password"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPassword: password })
    });
    if (res.status === 401) {
      window.location.href = "/customer-login.html";
      return;
    }
    const data = await res.json();
    if (!res.ok) {
      showResetMessage(data.error || "Unable to reset password.", false);
      return;
    }
    showResetMessage("Password updated. Redirecting to dashboard...", true);
    setTimeout(() => {
      window.location.href = data.redirectTo || "/ui/fleetai-dashboard.html";
    }, 1000);
  } catch (err) {
    showResetMessage("Reset failed. Try again.", false);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("resetPasswordBtn");
  if (btn) btn.addEventListener("click", submitReset);
  const confirm = document.getElementById("resetPasswordConfirm");
  if (confirm) {
    confirm.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submitReset();
      }
    });
  }
});
