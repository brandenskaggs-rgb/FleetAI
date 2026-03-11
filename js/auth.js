const USER_KEY = "fleetai.user";

function setUser(user) {
  try { localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch (e) {}
}

function showLoginMessage(text) {
  const el = document.getElementById("loginMessage");
  if (!el) return;
  el.textContent = text;
  el.style.display = "block";
}

async function loginCustomer() {
  const email = document.getElementById("loginEmail")?.value.trim() || "";
  const orgName = document.getElementById("loginOrg")?.value.trim() || "";
  const password = document.getElementById("loginPass")?.value || "";
  if (!email || !password) {
    showLoginMessage("Email and password are required.");
    return;
  }
  try {
    const res = await fetch("/api/auth/customer/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email, password, orgName })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const code = data.code || data.error;
      if (res.status === 409 && code === "PASSWORD_SETUP_REQUIRED" && data.setupToken) {
        try {
          sessionStorage.setItem("fleetai_first_login_token", data.setupToken);
          sessionStorage.setItem("fleetai_first_login_email", email);
          sessionStorage.setItem("fleetai_first_login_role", "customer");
        } catch (e) {}
        window.location.href = "/set-password.html";
        return;
      }
      if (code === "USER_NOT_FOUND") {
        showLoginMessage("User not found.");
        return;
      }
      if (code === "INVALID_CREDENTIALS") {
        showLoginMessage("Invalid credentials.");
        return;
      }
      showLoginMessage(data.message || "Login failed.");
      return;
    }
    if (data.session?.token) {
      try { localStorage.setItem("fleetai_customer_token", data.session.token); } catch (e) {}
    }
    setUser({ email, orgName, role: data.user?.role || "CUSTOMER" });
    window.location.href = data.redirectTo || "/ui/fleetai-dashboard.html";
  } catch (err) {
    showLoginMessage("Login failed.");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("btnLogin");
  if (btn) btn.addEventListener("click", loginCustomer);
});
