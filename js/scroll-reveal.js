function initScrollReveal(){
  if(document.body && document.body.classList.contains("landingV2")){
    document.querySelectorAll("section[id], h1[id], h2[id], h3[id]").forEach((el) => el.classList.add("anchor"));
    return;
  }
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  document.querySelectorAll("section[id], h1[id], h2[id], h3[id]").forEach((el) => el.classList.add("anchor"));
  const targets = Array.from(document.querySelectorAll(".section, .sectionHeader, .card, .panel, .hero"))
    .filter((el) => !el.classList.contains("reveal"))
    .filter((el) => !el.closest(".legal-page"));
  targets.forEach((el) => el.classList.add("reveal"));
  if (reduce.matches) {
    document.querySelectorAll(".reveal").forEach((el) => el.classList.add("is-visible"));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12, rootMargin: "0px 0px -10% 0px" });
  document.querySelectorAll(".reveal").forEach((el) => observer.observe(el));
}

document.addEventListener("DOMContentLoaded", initScrollReveal);
