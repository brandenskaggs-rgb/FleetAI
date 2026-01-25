const USER_KEY = "fleetai.user";
const ADDON_KEY = "fleetai.addons";

function getUser(){
  try{ return JSON.parse(localStorage.getItem(USER_KEY) || "null"); }catch(e){ return null; }
}
function setUser(user){
  try{ localStorage.setItem(USER_KEY, JSON.stringify(user)); }catch(e){}
}
function saveAddons(addons){
  try{ localStorage.setItem(ADDON_KEY, JSON.stringify(addons)); }catch(e){}
}

function applyPlan(plan){
  const user = getUser();
  if(!user) return;
  user.planStatus = plan === "pilot" ? "pilot" : "paid";
  user.planName = plan;
  setUser(user);
  renderPlanState(user);
}

function renderPlanState(user){
  const el = document.getElementById("billingStatus");
  if(!el) return;
  const status = user.planStatus || "none";
  el.textContent = status === "none" ? "No plan selected" : `Plan: ${user.planName || status}`;
}

function bindBilling(){
  const user = getUser();
  if(!user) return;
  renderPlanState(user);

  const btnPilot = document.getElementById("btnActivatePilot");
  if(btnPilot){
    btnPilot.addEventListener("click", ()=>{
      const code = document.getElementById("billingCode")?.value.trim();
      if(code !== "PILOT2026"){
        const msg = document.getElementById("billingMsg");
        if(msg){ msg.textContent = "Invalid pilot code."; msg.style.display = "block"; }
        return;
      }
      applyPlan("pilot");
    });
  }

  document.querySelectorAll("[data-plan]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const plan = btn.getAttribute("data-plan");
      if(plan) applyPlan(plan);
    });
  });

  const addonForm = document.getElementById("addonForm");
  if(addonForm){
    addonForm.addEventListener("change", ()=>{
      const addons = {};
      addonForm.querySelectorAll("input[type=checkbox]").forEach(cb=>{
        addons[cb.name] = cb.checked;
      });
      saveAddons(addons);
    });
  }
}

document.addEventListener("DOMContentLoaded", bindBilling);
