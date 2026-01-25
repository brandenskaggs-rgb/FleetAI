const USER_KEY = "fleetai.user";

function setUser(user){
  try{ localStorage.setItem(USER_KEY, JSON.stringify(user)); }catch(e){}
}

function getUser(){
  try{ return JSON.parse(localStorage.getItem(USER_KEY) || "null"); }catch(e){ return null; }
}

function loginPilot(){
  const email = document.getElementById("loginEmail")?.value.trim();
  const orgName = document.getElementById("loginOrg")?.value.trim();
  const access = document.getElementById("loginCode")?.value.trim();
  if(!email){
    showLoginMessage("Email is required.");
    return;
  }
  const planStatus = access === "PILOT2026" ? "pilot" : "none";
  setUser({
    email,
    orgName: orgName || "Fleet AI",
    planStatus
  });
  if(planStatus === "pilot"){
    window.location.href = "/app/dashboard.html";
  } else {
    window.location.href = "/app/billing.html";
  }
}

function showLoginMessage(text){
  const el = document.getElementById("loginMessage");
  if(!el) return;
  el.textContent = text;
  el.style.display = "block";
}

document.addEventListener("DOMContentLoaded", ()=>{
  const btn = document.getElementById("btnLogin");
  if(btn) btn.addEventListener("click", loginPilot);
});
