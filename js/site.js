function toggleNav(){
  const nav = document.getElementById("siteNav");
  if(!nav) return;
  nav.classList.toggle("is-open");
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
  form.addEventListener("submit", (e)=>{
    e.preventDefault();
    const payload = {
      name: document.getElementById("demoName")?.value.trim() || "",
      company: document.getElementById("demoCompany")?.value.trim() || "",
      email: document.getElementById("demoEmail")?.value.trim() || "",
      phone: document.getElementById("demoPhone")?.value.trim() || "",
      fleet: document.getElementById("demoFleet")?.value || "",
      pain: document.getElementById("demoPain")?.value || "",
      notes: document.getElementById("demoNotes")?.value.trim() || "",
      ts: new Date().toISOString()
    };
    try{
      const key = "fleetai.demoRequests";
      const raw = localStorage.getItem(key);
      const list = raw ? JSON.parse(raw) : [];
      list.push(payload);
      localStorage.setItem(key, JSON.stringify(list));
    }catch(err){}
    const success = document.getElementById("demoSuccess");
    if(success) success.style.display = "block";
    form.reset();
  });
}

function initPilotForm(){
  const form = document.getElementById("pilotForm");
  if(!form) return;
  form.addEventListener("submit", (e)=>{
    e.preventDefault();
    const payload = {
      name: document.getElementById("pilotName")?.value.trim() || "",
      company: document.getElementById("pilotCompany")?.value.trim() || "",
      email: document.getElementById("pilotEmail")?.value.trim() || "",
      phone: document.getElementById("pilotPhone")?.value.trim() || "",
      fleet: document.getElementById("pilotFleet")?.value || "",
      notes: document.getElementById("pilotNotes")?.value.trim() || "",
      ts: new Date().toISOString()
    };
    try{
      const key = "fleetai.pilotRequests";
      const raw = localStorage.getItem(key);
      const list = raw ? JSON.parse(raw) : [];
      list.push(payload);
      localStorage.setItem(key, JSON.stringify(list));
    }catch(err){}
    const success = document.getElementById("pilotSuccess");
    if(success) success.style.display = "block";
    form.reset();
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

function applyTheme(theme){
  const supported = ["light-blue","dark-blue","dark-gray"];
  const mode = supported.includes(theme) ? theme : "light-blue";
  document.documentElement.dataset.theme = mode;
  try{ localStorage.setItem("fleetai.theme", mode); }catch(e){}
  return mode;
}

function initThemeSwitch(){
  let theme = "dark-blue";
  try{
    const saved = localStorage.getItem("fleetai.theme");
    if(saved) theme = saved;
  }catch(e){}
  theme = applyTheme(theme);
  const select = document.getElementById("siteThemeSelect");
  if(select){
    select.value = theme;
    select.addEventListener("change", (e)=>{
      applyTheme(e.target.value);
    });
  }
}

document.addEventListener("DOMContentLoaded", ()=>{
  initNav();
  initAccordion();
  initDemoForm();
  initPilotForm();
  initAnchors();
  initThemeSwitch();
});
