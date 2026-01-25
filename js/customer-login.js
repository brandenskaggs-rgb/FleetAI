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

function resolveApiUrl(path) {
  if (typeof window.resolveApiUrl === "function") return window.resolveApiUrl(path);
  if (typeof window.apiUrl === "function") return window.apiUrl(path);
  const base = window.__FLEETAI__?.apiBase || "";
  if (!base) return path;
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return path.startsWith("/") ? `${base}${path}` : `${base}/${path}`;
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
    const res = await fetch(resolveApiUrl("/api/auth/customer/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email, password })
    });
    const parsed = await safeJson(res);
    if (!parsed.okParse) {
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
        showCustomerLoginMessage("User not found.", false);
        return;
      }
      if (code === "INVALID_CREDENTIALS") {
        showCustomerLoginMessage("Invalid credentials.", false);
        return;
      }
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
    showCustomerLoginMessage("Login failed. Try again.", false);
  } finally {
    if (btn) btn.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
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
