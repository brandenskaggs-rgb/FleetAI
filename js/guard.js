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
  const user = requireAuth();
  if(!user) return;
}

document.addEventListener("DOMContentLoaded", guardAppPage);
