const USER_KEY = "fleetai.user";

function getUser(){
  try{ return JSON.parse(localStorage.getItem(USER_KEY) || "null"); }catch(e){ return null; }
}

function requireAuth(){
  const user = getUser();
  if(!user){
    window.location.href = "/login.html";
    return null;
  }
  return user;
}

function guardAppPage(){
  const path = window.location.pathname;
  const isDashboard = path.includes("/app/dashboard.html");
  if(isDashboard){
    return;
  }
  const user = requireAuth();
  if(!user) return;
  const isBilling = path.includes("/app/billing.html");
  if(user.planStatus !== "pilot" && user.planStatus !== "paid"){
    if(!isBilling){
      window.location.href = "/app/billing.html";
    }
  }
}

document.addEventListener("DOMContentLoaded", guardAppPage);
