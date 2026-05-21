function toggleNav(){
  const nav = document.getElementById("siteNav");
  if(!nav) return;
  nav.classList.toggle("is-open");
}

const apiUrl = window.apiUrl || ((path)=> path);

const SITE_DIAG = (() => {
  try{
    const params = new URLSearchParams(window.location.search);
    if(params.get("diag") === "1") return true;
    return localStorage.getItem("fleetai.diagnostics") === "true";
  }catch(e){
    return false;
  }
})();

function diagLog(){
  if(!SITE_DIAG) return;
  console.log.apply(console, ["[diagnostics]"].concat(Array.from(arguments)));
}

function initNav(){
  const btn = document.getElementById("navToggle");
  if(btn) btn.addEventListener("click", toggleNav);
  const nav = document.getElementById("siteNav");
  if(nav){
    nav.querySelectorAll("a").forEach((link)=>{
      link.addEventListener("click", ()=>{
        nav.classList.remove("is-open");
      });
    });
  }
}

function initAccordion(){
  document.querySelectorAll(".accordion__trigger").forEach((btn)=>{
    btn.addEventListener("click", ()=>{
      const item = btn.closest(".accordion__item");
      if(!item) return;
      const open = item.classList.toggle("is-open");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    });
  });
}

function initDemoForm(){
  const form = document.getElementById("demoForm");
  if(!form) return;
  form.addEventListener("submit", async (e)=>{
    e.preventDefault();
    const companyName = document.getElementById("demoCompany")?.value.trim() || "";
    const contactName = document.getElementById("demoName")?.value.trim() || "";
    const email = document.getElementById("demoEmail")?.value.trim() || "";
    const phone = document.getElementById("demoPhone")?.value.trim() || "";
    const fleetSize = document.getElementById("demoFleetSize")?.value.trim() || "";
    const message = document.getElementById("demoMessage")?.value.trim() || "";
    const success = document.getElementById("demoSuccess");
    const error = document.getElementById("demoError");
    if(success) success.style.display = "none";
    if(error) error.style.display = "none";
    if(!/^[^@]+@[^@]+\.[^@]+$/.test(email)){
      if(error){
        error.textContent = "Please enter a valid email address.";
        error.style.display = "block";
      }
      return;
    }
    const btn = form.querySelector("button[type='submit']");
    if(btn) btn.disabled = true;
    try{
      diagLog("submit", "request-demo");
      const res = await fetch(apiUrl("/api/leads/request-demo"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leadType: "DEMO",
          companyName,
          contactName,
          email,
          phone,
          fleetSize,
          message,
          sourcePage: window.location.pathname || "web"
        })
      });
      const data = await res.json().catch(()=> ({}));
      if(!res.ok){
        throw new Error(data.error || "Request failed");
      }
      if(success) success.style.display = "block";
      form.reset();
    }catch(err){
      if(error){
        error.textContent = err && err.message ? err.message : "Unable to submit. Please try again.";
        error.style.display = "block";
      }
    }finally{
      if(btn) btn.disabled = false;
    }
  });
}

function initPilotForm(){
  const form = document.getElementById("pilotForm");
  if(!form) return;
  form.addEventListener("submit", async (e)=>{
    e.preventDefault();
    const companyName = document.getElementById("pilotCompany")?.value.trim() || "";
    const contactName = document.getElementById("pilotName")?.value.trim() || "";
    const email = document.getElementById("pilotEmail")?.value.trim() || "";
    const phone = document.getElementById("pilotPhone")?.value.trim() || "";
    const fleetSize = document.getElementById("pilotFleet")?.value || "";
    const message = document.getElementById("pilotNotes")?.value.trim() || "";
    const success = document.getElementById("pilotSuccess");
    const error = document.getElementById("pilotError");
    if(success) success.style.display = "none";
    if(error) error.style.display = "none";
    if(!/^[^@]+@[^@]+\.[^@]+$/.test(email)){
      if(error){
        error.textContent = "Please enter a valid email address.";
        error.style.display = "block";
      }
      return;
    }
    const btn = form.querySelector("button[type='submit']");
    if(btn) btn.disabled = true;
    try{
      diagLog("submit", "pilot-apply");
      const res = await fetch(apiUrl("/api/leads/pilot-apply"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leadType: "PILOT",
          companyName,
          contactName,
          email,
          phone,
          fleetSize,
          message,
          sourcePage: window.location.pathname || "web"
        })
      });
      const data = await res.json().catch(()=> ({}));
      if(!res.ok){
        throw new Error(data.error || "Request failed");
      }
      if(success) success.style.display = "block";
      form.reset();
    }catch(err){
      if(error){
        error.textContent = err && err.message ? err.message : "Unable to submit. Please try again.";
        error.style.display = "block";
      }
    }finally{
      if(btn) btn.disabled = false;
    }
  });
}

function initAnchors(){
  document.querySelectorAll('a[href^="#"]').forEach((link)=>{
    link.addEventListener("click", (e)=>{
      const targetId = link.getAttribute("href");
      if(!targetId || targetId === "#") return;
      const el = document.querySelector(targetId);
      if(!el) return;
      e.preventDefault();
      el.scrollIntoView({behavior:"smooth", block:"start"});
    });
  });
}

function applyTheme(){
  const mode = "light-blue";
  document.documentElement.dataset.theme = mode;
  try{ localStorage.removeItem("fleetai.theme"); }catch(e){}
  return mode;
}

function initThemeSwitch(){
  applyTheme();
  document.querySelectorAll("#siteThemeSelect,.themeSelect").forEach((control)=>{
    control.setAttribute("hidden", "");
    control.setAttribute("aria-hidden", "true");
  });
}

document.addEventListener("DOMContentLoaded", ()=>{
  initNav();
  initAccordion();
  initDemoForm();
  initPilotForm();
  initAnchors();
  initThemeSwitch();
});
