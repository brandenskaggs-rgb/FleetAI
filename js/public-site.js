"use strict";
(() => {
  const menu=document.getElementById("publicMenu"),nav=document.getElementById("publicNav");
  if(menu&&nav){
    const close=()=>{nav.classList.remove("is-open");menu.setAttribute("aria-expanded","false");menu.setAttribute("aria-label","Open navigation");};
    menu.addEventListener("click",()=>{const open=nav.classList.toggle("is-open");menu.setAttribute("aria-expanded",String(open));menu.setAttribute("aria-label",open?"Close navigation":"Open navigation");});
    nav.addEventListener("click",event=>{if(event.target.closest("a"))close();});
    document.addEventListener("keydown",event=>{if(event.key==="Escape"&&nav.classList.contains("is-open")){close();menu.focus();}});
    document.addEventListener("click",event=>{if(!event.target.closest(".publicHeader"))close();});
    matchMedia("(min-width: 961px)").addEventListener("change",close);
  }
  const motion=matchMedia("(prefers-reduced-motion: reduce)");
  const video=document.getElementById("heroVideo"),control=document.getElementById("videoControl");
  if(video&&control){
    let userPaused=false,visible=true;
    const sync=()=>{const action=video.paused?"Play":"Pause";control.textContent=action+" film";control.setAttribute("aria-label",action+" background video");};
    const play=()=>video.play().catch(()=>sync());
    control.addEventListener("click",()=>{if(video.paused){userPaused=false;play();}else{userPaused=true;video.pause();}});
    video.addEventListener("play",sync);video.addEventListener("pause",sync);video.addEventListener("error",sync);
    const respect=()=>{if(motion.matches||document.hidden||!visible)video.pause();else if(!userPaused&&!navigator.connection?.saveData)play();sync();};
    motion.addEventListener("change",respect);document.addEventListener("visibilitychange",respect);
    if(window.IntersectionObserver)new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;respect();},{threshold:.05}).observe(video);
    respect();
  }
  if(window.IntersectionObserver&&!motion.matches){
    const observer=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting){entry.target.classList.add("is-visible");observer.unobserve(entry.target);}}),{threshold:.08});
    document.querySelectorAll("[data-reveal]").forEach(node=>{node.classList.add("reveal-ready");observer.observe(node);});
  }
})();
