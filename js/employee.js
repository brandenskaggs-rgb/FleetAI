function employeeShowError(message){
  const el = document.getElementById("employeeError");
  if(!el) return;
  el.style.display = "block";
  el.textContent = message;
}

const apiUrl = window.apiUrl || ((path) => path);
const EMPLOYEE_LOGIN_ENDPOINT = "/api/auth/employee/login";

function employeeClearError(){
  const el = document.getElementById("employeeError");
  if(!el) return;
  el.style.display = "none";
  el.textContent = "";
}

function employeeSetStatus(message){
  const el = document.getElementById("employeeStatus");
  if(!el) return;
  if(!message){
    el.style.display = "none";
    el.textContent = "";
    return;
  }
  el.style.display = "block";
  el.textContent = message;
}

function employeeSetDebug({ endpoint, status, error, reloading }) {
  const elEndpoint = document.getElementById("employeeDebugEndpoint");
  const elStatus = document.getElementById("employeeDebugStatus");
  const elError = document.getElementById("employeeDebugError");
  const elReload = document.getElementById("employeeDebugReload");
  if (elEndpoint && endpoint !== undefined) elEndpoint.textContent = `Endpoint: ${endpoint || "--"}`;
  if (elStatus && status !== undefined) elStatus.textContent = `Last status: ${status}`;
  if (elError && error !== undefined) elError.textContent = `Last error: ${error || "--"}`;
  if (elReload && reloading !== undefined) elReload.textContent = `Reload detected: ${reloading ? "yes" : "no"}`;
}

function employeeSetSubmitting(isSubmitting){
  const btn = document.getElementById("employeeSignIn");
  if(btn) btn.disabled = isSubmitting;
  employeeSetStatus(isSubmitting ? "Connecting..." : "");
}

async function employeeSubmitLogin(e){
  if (e) {
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
  }
  console.log("EMP_LOGIN: submit fired");
  const emailInput = document.getElementById("employeeEmail");
  const passwordInput = document.getElementById("employeePassword");
  const twofaInput = document.getElementById("employee2fa");
  const payload = {
    email: emailInput?.value.trim() || "",
    password: passwordInput?.value || "",
    twofa: twofaInput?.value.trim() || ""
  };
  employeeClearError();
  employeeSetStatus("Logging in...");
  employeeSetDebug({ endpoint: EMPLOYEE_LOGIN_ENDPOINT, status: "sending", error: "--" });
  if (!payload.email || !payload.password) {
    employeeShowError("Please enter your email and password.");
    employeeSetSubmitting(false);
    return;
  }
  console.log(`EMP_LOGIN: calling endpoint ${EMPLOYEE_LOGIN_ENDPOINT}`);
  try {
    const res = await fetch(apiUrl(EMPLOYEE_LOGIN_ENDPOINT), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload)
    });
    employeeSetDebug({ status: res.status });
    console.log(`EMP_LOGIN: response status ${res.status}`);
    const data = await res.json().catch(() => ({}));
    console.log("EMP_LOGIN: response body", data);
    if (!res.ok || data.ok === false) {
      const code = data.code || data.error;
      if (res.status === 409 && code === "PASSWORD_SETUP_REQUIRED" && data.setupToken) {
        const token = data.setupToken;
        window.location.href = `/set-password.html?token=${encodeURIComponent(token)}&email=${encodeURIComponent(payload.email)}&type=employee`;
        return;
      }
      const message = code === "auth_store_empty"
        ? "Server has no users loaded. Contact an admin."
        : code === "inactive_user"
          ? "Account exists but is inactive. Contact admin."
        : code === "user_not_found" || code === "USER_NOT_FOUND"
          ? "User not found."
        : code === "missing_org"
          ? "Account missing organization assignment."
                : code === "INVALID_CREDENTIALS"
                  ? (data.message || "Invalid credentials")
                  : data.message || data.error || "Login failed";
      employeeShowError(message);
      employeeSetDebug({ error: message });
      employeeSetSubmitting(false);
      return;
    }
    if (data.token) {
      console.log("EMP_LOGIN: storing auth");
      try { localStorage.setItem("fleetai.employeeToken", data.token); } catch(e){}
    }
    const dest = data.redirect || "/employee-portal.html";
    console.log(`EMP_LOGIN: redirecting to ${dest}`);
    window.location.href = dest;
  } catch (err) {
    const message = err?.message || "Login failed";
    employeeShowError(message);
    employeeSetDebug({ error: message, status: "ERR" });
  } finally {
    employeeSetSubmitting(false);
  }
}

async function employeeSignOut(){
  try{
    await fetch(apiUrl("/api/employee/logout"), { method: "POST" });
  }catch(err){}
  try{ localStorage.removeItem("fleetai.employeeToken"); }catch(e){}
  window.location.href = "./employee-login.html";
}

async function employeeRequireSession(){
  try{
    const token = localStorage.getItem("fleetai.employeeToken");
    if (!token) {
      window.location.href = "./employee-login.html";
      return null;
    }
  }catch(e){}
  try{
    const token = localStorage.getItem("fleetai.employeeToken");
    const res = await fetch(apiUrl("/api/employee/session"), {
      credentials: "include",
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    if(!res.ok){
      window.location.href = "./employee-login.html";
      return null;
    }
    const data = await res.json();
    return data.employee || null;
  }catch(err){
    window.location.href = "./employee-login.html";
    return null;
  }
}

async function employeeInitPortal(){
  const session = await employeeRequireSession();
  if(!session) return;
  const roleEl = document.getElementById("portalRole");
  if(roleEl) roleEl.textContent = "Role: " + session.role;
  const signOut = document.getElementById("employeeSignOut");
  if(signOut) signOut.addEventListener("click", employeeSignOut);

  const nav = document.getElementById("portalNav");
  if(!nav) return;
  const panels = document.querySelectorAll("[data-panel]");
  const role = session.role || "SUPPORT";
  const allowed = {
    SUPER_ADMIN: ["fleets","support","system","learning","billing","settings"],
    SUPPORT: ["fleets","support","system","learning"],
    ENGINEERING: ["system","learning","billing"]
  };
  nav.querySelectorAll("button").forEach((btn)=>{
    const key = btn.getAttribute("data-section");
    if(!allowed[role] || !allowed[role].includes(key)){
      btn.hidden = true;
    }
  });
  panels.forEach((panel)=>{
    const key = panel.getAttribute("data-panel");
    if(!allowed[role] || !allowed[role].includes(key)){
      panel.hidden = true;
    }
  });
  const firstKey = allowed[role]?.[0];
  if(firstKey){
    nav.querySelectorAll("button").forEach((btn)=>{
      btn.classList.toggle("is-active", btn.getAttribute("data-section") === firstKey);
    });
    panels.forEach((panel)=>{
      panel.hidden = panel.getAttribute("data-panel") !== firstKey;
    });
    const title = document.querySelector(".portalTitle");
    const firstBtn = nav.querySelector(`button[data-section=\"${firstKey}\"]`);
    if(title && firstBtn) title.textContent = firstBtn.textContent.replace(" (Read-Only)", "");
  }
  nav.querySelectorAll("button").forEach((btn)=>{
    btn.addEventListener("click", ()=>{
      nav.querySelectorAll("button").forEach((b)=> b.classList.remove("is-active"));
      btn.classList.add("is-active");
      const target = btn.getAttribute("data-section");
      panels.forEach((panel)=>{
        const name = panel.getAttribute("data-panel");
        panel.hidden = name !== target;
      });
      const title = document.querySelector(".portalTitle");
      if(title) title.textContent = btn.textContent.replace(" (Read-Only)", "");
    });
  });
}

function employeeInitLogin(){
  const form = document.getElementById("employeeLoginForm");
  if(form) {
    form.addEventListener("submit", employeeSubmitLogin, { capture: true });
    form.addEventListener("reset", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
      console.warn("EMP_LOGIN: reset blocked");
    }, { capture: true });
  }
  const btn = document.getElementById("employeeSignIn");
  if (btn) {
    btn.addEventListener("click", () => {
      console.log("EMP_LOGIN: click fired");
    });
  }
}

document.addEventListener("DOMContentLoaded", ()=>{
  console.log("EMP_LOGIN: DOMContentLoaded");
  window.addEventListener("beforeunload", () => {
    window.__loginReloading = true;
    console.warn("EMP_LOGIN: page unloading/reloading");
    employeeSetDebug({ reloading: true });
  });
  if(document.getElementById("employeeSignIn")) employeeInitLogin();
  if(document.getElementById("portalNav")) employeeInitPortal();
  employeeSetDebug({ endpoint: EMPLOYEE_LOGIN_ENDPOINT, reloading: false, status: "--", error: "--" });
});

document.addEventListener("click", (e) => {
  const btn = document.getElementById("employeeSignIn");
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const pointEl = document.elementFromPoint(x, y);
  if (pointEl && pointEl !== btn && !btn.contains(pointEl)) {
    console.warn("EMP_LOGIN: click intercepted by", pointEl);
    pointEl.style.outline = "2px solid red";
  }
});
