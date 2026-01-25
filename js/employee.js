function employeeShowError(message){
  const el = document.getElementById("employeeError");
  if(!el) return;
  el.style.display = "block";
  el.textContent = message;
}

function employeeClearError(){
  const el = document.getElementById("employeeError");
  if(!el) return;
  el.style.display = "none";
  el.textContent = "";
}

async function employeeSignIn(){
  const email = document.getElementById("employeeEmail")?.value.trim() || "";
  const password = document.getElementById("employeePassword")?.value || "";
  employeeClearError();
  if(!email || !password){
    employeeShowError("Please enter your email and password.");
    return;
  }
  try{
    const res = await fetch("/api/employee/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if(!res.ok){
      employeeShowError(data.error || "Invalid credentials.");
      return;
    }
    if (data.token) {
      try { localStorage.setItem("fleetai.employeeToken", data.token); } catch(e){}
    }
    window.location.href = "./employee-portal.html";
  }catch(err){
    employeeShowError("Login failed. Try again.");
  }
}

async function employeeSignOut(){
  try{
    await fetch("/api/employee/logout", { method: "POST" });
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
    const res = await fetch("/api/employee/session");
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
  const btn = document.getElementById("employeeSignIn");
  if(btn) btn.addEventListener("click", employeeSignIn);
  const password = document.getElementById("employeePassword");
  if(password){
    password.addEventListener("keydown", (e)=>{
      if(e.key === "Enter"){
        e.preventDefault();
        employeeSignIn();
      }
    });
  }
}

document.addEventListener("DOMContentLoaded", ()=>{
  if(document.getElementById("employeeSignIn")) employeeInitLogin();
  if(document.getElementById("portalNav")) employeeInitPortal();
});
