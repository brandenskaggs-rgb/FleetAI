const USER_KEY = "fleetai.user";
const COMPANY_KEY = "fleetai.companyName";

function getUser(){
  try{ return JSON.parse(localStorage.getItem(USER_KEY) || "null"); }catch(e){ return null; }
}

function initHeader(){
  const user = getUser();
  const name = user?.orgName || (localStorage.getItem(COMPANY_KEY) || "Fleet AI");
  const el = document.getElementById("appOrgName");
  if(el) el.textContent = name;
}

function bindLogout(){
  const btn = document.getElementById("btnAppLogout");
  if(!btn) return;
  btn.addEventListener("click", ()=>{
    try{ localStorage.removeItem(USER_KEY); }catch(e){}
    window.location.href = "/login.html";
  });
}

document.addEventListener("DOMContentLoaded", ()=>{
  initHeader();
  bindLogout();
});
