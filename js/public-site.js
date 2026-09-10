"use strict";
(() => {
  const menu = document.getElementById("publicMenu");
  const nav = document.getElementById("publicNav");
  if (menu && nav) {
    const close = () => { nav.classList.remove("is-open"); menu.setAttribute("aria-expanded", "false"); menu.setAttribute("aria-label", "Open navigation"); };
    menu.addEventListener("click", () => {
      const open = nav.classList.toggle("is-open");
      menu.setAttribute("aria-expanded", String(open));
      menu.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    });
    nav.addEventListener("click", event => { if (event.target.closest("a")) close(); });
    document.addEventListener("keydown", event => { if (event.key === "Escape" && nav.classList.contains("is-open")) { close(); menu.focus(); } });
    document.addEventListener("click", event => { if (!event.target.closest(".publicHeader")) close(); });
    window.matchMedia("(min-width: 961px)").addEventListener("change", close);
  }
  const video = document.getElementById("heroVideo");
  const control = document.getElementById("videoControl");
  if (video && control) {
    const sync = () => {
      const action = video.paused ? "Play" : "Pause";
      control.setAttribute("aria-label", `${action} background video`);
      control.title = `${action} background video`;
      control.textContent = video.paused ? "\u25b6" : "\u2161";
    };
    control.addEventListener("click", async () => {
      if (video.paused) { try { await video.play(); } catch (_) { sync(); } }
      else video.pause();
    });
    video.addEventListener("play", sync);
    video.addEventListener("pause", sync);
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const respectMotion = () => { if (motion.matches) { video.autoplay = false; video.pause(); } sync(); };
    motion.addEventListener("change", respectMotion);
    respectMotion();
  }
})();
