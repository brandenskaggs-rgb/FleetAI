"use strict";
(() => {
  const root = document.getElementById("prediction");
  if (!root || !window.IntersectionObserver) return;
  const road = document.getElementById("roadFrames"), link = document.getElementById("linkFrames");
  const chapters = [...root.querySelectorAll("[data-chapter]")];
  const buttons = [...root.querySelectorAll("[data-story-target]")];
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const short = matchMedia("(max-height: 620px)");
  let manualReduced = false, enabled = false, near = false, scheduled = false;
  let progress = 0, stage = -1;
  const clamp = (x, min=0, max=1) => Math.max(min, Math.min(max, x));

  // Small decode caches avoid retaining a full video sequence in phone memory.
  class Frames {
    constructor(folder, count, capacity) { this.folder=folder; this.count=count; this.capacity=capacity; this.cache=new Map(); this.pending=new Set(); this.failed=new Set(); this.target=0; }
    request(index) {
      if (this.cache.has(index) || this.pending.has(index) || this.failed.has(index) || this.pending.size>=3) return;
      this.pending.add(index);
      const image = new Image();
      image.decoding="async";
      image.onload=()=>{
        this.pending.delete(index); this.cache.set(index,image);
        while(this.cache.size>this.capacity) {
          const farthest=[...this.cache.keys()].sort((a,b)=>Math.abs(b-this.target)-Math.abs(a-this.target))[0];
          this.cache.delete(farthest);
        }
        schedule();
      };
      image.onerror=()=>{this.pending.delete(index);this.failed.add(index);};
      image.src=`/assets/motion/${this.folder}/frame-${String(index+1).padStart(3,"0")}.webp`;
    }
    get(index) {
      this.target=clamp(index,0,this.count-1);
      this.request(this.target);
      for(const offset of [1,-1,2,-2]) if(this.target+offset>=0 && this.target+offset<this.count) this.request(this.target+offset);
      const nearest=[...this.cache.keys()].sort((a,b)=>Math.abs(a-this.target)-Math.abs(b-this.target))[0];
      return nearest===undefined ? null : {image:this.cache.get(nearest),index:nearest};
    }
  }
  const roads=new Frames("highway",60,10), links=new Frames("link",48,8);
  function draw(canvas, frame, cover) {
    if(!frame) return;
    const rect=canvas.getBoundingClientRect(), dpr=Math.min(devicePixelRatio||1,1.5);
    if(!rect.width || !rect.height) return;
    const width=Math.round(rect.width*dpr),height=Math.round(rect.height*dpr);
    if(canvas.width!==width || canvas.height!==height){canvas.width=width;canvas.height=height;canvas.dataset.frame="";}
    if(canvas.dataset.frame===String(frame.index)) return;
    const context=canvas.getContext("2d");
    if(!context) return;
    const {image}=frame;
    const scale=(cover?Math.max:Math.min)(width/image.width,height/image.height);
    context.clearRect(0,0,width,height);
    context.drawImage(image,(width-image.width*scale)/2,(height-image.height*scale)/2,image.width*scale,image.height*scale);
    canvas.dataset.frame=String(frame.index);
    if(canvas===link) canvas.parentElement.classList.add("has-frames");
  }
  function render() {
    scheduled=false;
    if(!enabled || !near) return;
    const rect=root.getBoundingClientRect(), sticky=root.querySelector(".signalStage");
    const top=parseFloat(getComputedStyle(sticky).top)||0;
    progress=clamp((top-rect.top)/Math.max(1,root.offsetHeight-sticky.offsetHeight));
    const next=progress<.3?0:progress<.7?1:2;
    if(next!==stage){
      stage=next;root.dataset.stage=String(stage);
      chapters.forEach((chapter,i)=>{chapter.classList.toggle("is-active",i===stage);chapter.inert=i!==stage;});
      buttons.forEach((button,i)=>{if(i===stage)button.setAttribute("aria-current","step");else button.removeAttribute("aria-current");});
    }
    root.style.setProperty("--progress",`${progress*100}%`);
    root.style.setProperty("--wash",clamp((progress-.18)/.16).toFixed(3));
    root.style.setProperty("--object",clamp((progress-.26)/.15).toFixed(3));
    draw(road,roads.get(Math.round(clamp(progress/.4)*59)),true);
    if(progress>.16) draw(link,links.get(Math.round(clamp((progress-.2)/.7)*47)),false);
  }
  function schedule(){if(!scheduled){scheduled=true;requestAnimationFrame(render);}}
  function configure(){
    enabled=!motion.matches&&!short.matches&&!manualReduced&&!navigator.connection?.saveData;
    root.classList.toggle("story-enhanced",enabled);stage=-1;
    if(!enabled){root.removeAttribute("data-stage");chapters.forEach(chapter=>{chapter.inert=false;chapter.classList.add("is-active");});}
    schedule();
  }
  buttons.forEach(button=>button.addEventListener("click",()=>{
    const sticky=root.querySelector(".signalStage"),top=parseFloat(getComputedStyle(sticky).top)||0;
    const target=[.08,.5,.91][Number(button.dataset.storyTarget)];
    scrollTo({top:scrollY+root.getBoundingClientRect().top-top+(root.offsetHeight-sticky.offsetHeight)*target,behavior:motion.matches?"instant":"smooth"});
  }));
  document.getElementById("storyMotionToggle")?.addEventListener("click",event=>{
    manualReduced=true;event.currentTarget.setAttribute("aria-pressed","true");configure();
    root.scrollIntoView({behavior:"instant",block:"start"});
  });
  new IntersectionObserver(entries=>{near=entries[0].isIntersecting;if(near)schedule();},{rootMargin:"500px"}).observe(root);
  addEventListener("scroll",schedule,{passive:true});addEventListener("resize",()=>{configure();schedule();});
  motion.addEventListener("change",configure);short.addEventListener("change",configure);
  configure();
})();
