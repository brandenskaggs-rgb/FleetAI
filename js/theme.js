const THEME_KEY = "fleetai.theme";
const THEMES = ["light-blue","dark-blue","dark-gray"];

function applyTheme(theme){
  const legacyMap = { light: "light-blue", haze: "light-blue" };
  const mode = THEMES.includes(theme) ? theme : (legacyMap[theme] || "light-blue");
  document.documentElement.dataset.theme = mode;
  try{ localStorage.setItem(THEME_KEY, mode); }catch(e){}
  return mode;
}

function loadTheme(){
  let theme = "light-blue";
  try{
    const saved = localStorage.getItem(THEME_KEY);
    if(saved) theme = saved;
  }catch(e){}
  theme = applyTheme(theme);
  const toggle = document.getElementById("themeToggle");
  if(toggle) toggle.value = theme;
}

document.addEventListener("DOMContentLoaded", loadTheme);
