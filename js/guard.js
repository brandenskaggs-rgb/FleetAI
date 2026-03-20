const USER_KEY = "fleetai.user";

function getUser(){
  try{ return JSON.parse(localStorage.getItem(USER_KEY) || "null"); }catch(e){ return null; }
}

function isSessionAuthPage(){
  try {
    const path = window.location.pathname || "";
    return path === "/ui/fleetai-dashboard.html" || path === "/fleetai-dashboard.html";
  } catch (e) {
    return false;
  }
}

function requireAuth(){
  if (isSessionAuthPage()) {
    // Customer dashboard auth is now enforced server-side via cookie sessions.
    // Do not apply legacy localStorage redirects here.
    return { sessionAuth: true };
  }
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
