const USER_KEY = "fleetai.user";
const COMPANY_KEY = "fleetai.companyName";

function getUser(){
  try{ return JSON.parse(localStorage.getItem(USER_KEY) || "null"); }catch(e){ return null; }
}
function setUser(user){
  try{ localStorage.setItem(USER_KEY, JSON.stringify(user)); }catch(e){}
}

function loadOrg(){
  const input = document.getElementById("settingsOrgName");
  if(!input) return;
  let name = "Fleet AI";
  try{
    const saved = localStorage.getItem(COMPANY_KEY);
    if(saved) name = saved;
  }catch(e){}
  input.value = name;
}

function saveOrg(){
  const input = document.getElementById("settingsOrgName");
  if(!input) return;
  const name = input.value.trim();
  if(!name) return;
  try{ localStorage.setItem(COMPANY_KEY, name); }catch(e){}
  const user = getUser();
  if(user){
    user.orgName = name;
    setUser(user);
  }
  const msg = document.getElementById("settingsMsg");
  if(msg){ msg.textContent = "Saved."; msg.style.display = "block"; }
}

document.addEventListener("DOMContentLoaded", ()=>{
  loadOrg();
  const btn = document.getElementById("btnSaveOrg");
  if(btn) btn.addEventListener("click", saveOrg);
});
