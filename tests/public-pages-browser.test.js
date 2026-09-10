"use strict";
// Local-only preview and browser fixtures. No credentials or production API calls.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");
const pages = ["index.html", "product.html", "pricing.html", "security.html", "about.html", "developers.html", "partner-docs.html", "pilot.html", "request-demo.html", "signup.html", "legal/privacy.html", "legal/terms.html", "customer-login.html", "employee-login.html", "org/reset-password.html", "ui/force-reset.html", "ui/settings/set-password.html", "assets/brand/download.html", "admin/setup.html"];
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".ttf": "font/ttf", ".mp4": "video/mp4" };
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname === "/index.html") { res.writeHead(301, { Location: "/" }).end(); return; }
  if (pathname.startsWith("/api/")) { res.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Local preview: live services are not connected." })); return; }
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const filename = path.resolve(root, relative);
  if (!filename.startsWith(root + path.sep) || !(pages.includes(relative) || /^(assets|css|js|ui\/js|public\/js)\//.test(relative))) { res.writeHead(404).end(); return; }
  try {
    const body = await fs.readFile(filename);
    res.writeHead(200, { "Content-Type": types[path.extname(filename)] || "application/octet-stream", "Cache-Control": "no-store" }).end(body);
  } catch (_) { res.writeHead(404).end(); }
});

(async () => {
  await new Promise(resolve => server.listen(process.argv.includes("--serve") ? 4175 : 0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  if (process.argv.includes("--serve")) { console.log(`Public website preview: ${base} (no live API access)`); return; }
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "fleetai-public-qa-"));
  const browser = await chromium.launch({ args: ["--disable-gpu"] });
  const errors = [], brokenAssets = [], overflow = [];
  const links = new Set();
  let screenshots = 0;
  try {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    page.on("pageerror", error => errors.push(error.message));
    page.on("response", response => {
      const url = new URL(response.url());
      if (response.status() >= 400 && !url.pathname.startsWith("/api/")) brokenAssets.push(url.pathname);
    });
    let submissions = [];
    let failSubmission = false;
    await page.route("**/api/**", async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/invites/")) {
        if (request.method() === "POST") submissions.push({ path: url.pathname, body: request.postDataJSON() });
        return route.fulfill({ json: { ok: true, data: { orgId: "demo-org", email: "qa@example.test", type: "CUSTOMER", expiresAt: "2027-01-01T00:00:00Z", role: "ORG_ADMIN" } } });
      }
      if (url.pathname.startsWith("/api/leads/")) {
        submissions.push({ path: url.pathname, body: request.postDataJSON() });
        return route.fulfill({ status: failSubmission ? 503 : 200, json: failSubmission ? { error: "Test service unavailable. Please try again." } : { ok: true } });
      }
      return route.fulfill({ status: 401, json: { error: "Unauthorized" } });
    });
    for (const width of [1440, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const file of pages) {
        console.log(`Checking ${width}px ${file}`);
        await page.goto(`${base}/${file}${file === "signup.html" ? "?token=synthetic-invite" : ""}`, { waitUntil: "networkidle" });
        await page.evaluate(() => document.fonts.ready);
        if (width === 1440) {
          for (const href of await page.locator("a[href]").evaluateAll(nodes => nodes.map(node => node.href))) {
            if (href.startsWith(base)) links.add(href);
          }
        }
        const dimensions = await page.evaluate(() => ({ full: document.documentElement.scrollWidth, viewport: innerWidth }));
        if (dimensions.full > dimensions.viewport + 1) overflow.push({ file, width, ...dimensions });
        const header = page.locator(".publicHeader");
        await header.waitFor({ state: "visible" });
        assert.ok(await page.locator("h1,h2").count(), `${file}: needs a visible heading`);
        if (width === 390 && await page.locator("#publicMenu").count()) {
          await page.locator("#publicMenu").click();
          assert.equal(await page.locator("#publicMenu").getAttribute("aria-expanded"), "true");
          assert.equal(await page.locator("#publicNav").isVisible(), true);
          await page.keyboard.press("Escape");
          assert.equal(await page.locator("#publicNav").isVisible(), false);
        }
        if (width === 1440 || width === 390) {
          if (["index.html", "product.html", "request-demo.html", "customer-login.html", "partner-docs.html"].includes(file)) {
            await page.screenshot({ path: path.join(output, `${file.replaceAll("/", "-")}-${width}.png`), fullPage: file !== "partner-docs.html", animations: "disabled", timeout: 60000 });
            screenshots++;
          }
        }
      }
    }
    for (const href of links) {
      const url = new URL(href);
      const result = await page.request.get(href);
      assert.equal(result.status(), 200, `Broken public link: ${url.pathname}`);
      if (url.hash) {
        const body = await result.text();
        assert.ok(body.includes(`id="${decodeURIComponent(url.hash.slice(1))}"`), `Missing section: ${url.pathname}${url.hash}`);
      }
    }
    for (const [file, prefix, pathSuffix] of [["request-demo.html", "demo", "request-demo"], ["pilot.html", "pilot", "pilot-apply"]]) {
      await page.goto(`${base}/${file}`);
      await page.locator(`#${prefix}Company`).fill("Synthetic test fleet");
      await page.locator(`#${prefix}Name`).fill("Test Operator");
      await page.locator(`#${prefix}Email`).fill("qa@example.test");
      await page.locator(`#${prefix}Region`).fill("Test region");
      if (prefix === "pilot") await page.locator("#pilotFleet").selectOption("1-25");
      failSubmission = true;
      await page.locator(`#${prefix}Form button[type=submit]`).click();
      await page.locator(`#${prefix}Error`).waitFor({ state: "visible" });
      assert.equal(await page.locator(`#${prefix}Company`).inputValue(), "Synthetic test fleet", "failed submissions retain user input");
      failSubmission = false;
      await page.locator(`#${prefix}Form button[type=submit]`).click();
      await page.locator(`#${prefix}Success`).waitFor({ state: "visible" });
      assert.equal(submissions.at(-1).path, `/api/leads/${pathSuffix}`);
      assert.match(submissions.at(-1).body.message, /Operating region: Test region/);
    }
    await page.goto(`${base}/signup.html`);
    assert.equal(await page.locator("#inviteSubmit").isDisabled(), true);
    await page.goto(`${base}/signup.html?token=synthetic-invite`);
    await page.locator("#invitePassword").fill("Synthetic-password-123");
    await page.locator("#inviteSubmit").click();
    await page.locator("#signupStatus").filter({ hasText: "Account activated" }).waitFor();
    assert.equal(submissions.at(-1).path, "/api/invites/synthetic-invite/accept");
    assert.equal(submissions.at(-1).body.email, "qa@example.test");
    // Exercise real scrolling and rendered pixels, not just the reduced-motion layout.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    for (const [width, height] of [[1440, 900], [1024, 768], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await page.goto(base, { waitUntil: "networkidle" });
      const heroBottom = await page.locator(".roadHero").evaluate(node => node.getBoundingClientRect().bottom);
      assert.ok(heroBottom < height, `Hero must reveal the next section at ${width}px`);
      await page.locator("#heroVideo").evaluate(video => video.pause());
      await page.screenshot({ path: path.join(output, `link-home-${width}.png`) });
      let previousPixels = null;
      for (const [chapter, fraction] of [[0, .08], [1, .5], [2, .91], [0, .1]]) {
        await page.evaluate(fraction => {
          const root=document.getElementById("prediction"),stage=root.querySelector(".signalStage");
          scrollTo({top:scrollY+root.getBoundingClientRect().top-parseFloat(getComputedStyle(stage).top)+(root.offsetHeight-stage.offsetHeight)*fraction,behavior:"instant"});
        }, fraction);
        await page.waitForFunction(chapter => document.getElementById("prediction").dataset.stage===String(chapter), chapter);
        const canvas = chapter===0 ? "roadFrames" : "linkFrames";
        await page.waitForFunction(({id,minimum}) => Number(document.getElementById(id).dataset.frame)>=minimum, {id:canvas,minimum:chapter===0?8:chapter===1?18:44});
        assert.equal(await page.locator(".storyChapter").evaluateAll(nodes => nodes.filter(node=>getComputedStyle(node).visibility!=="hidden").length),1,"Chapter transitions must not overlap text");
        await page.locator(`.storyChapter[data-chapter="${chapter}"]`).evaluate(node=>Promise.all(node.getAnimations().map(animation=>animation.finished)));
        const pixels=await page.locator(`#${canvas}`).evaluate(node => {
          const context=node.getContext("2d"),data=context.getImageData(0,0,node.width,node.height).data;
          let painted=0; for(let i=3;i<data.length;i+=4)if(data[i]>0)painted++;
          return { painted, frame:node.dataset.frame, digest:node.toDataURL().slice(-4000) };
        });
        assert.ok(pixels.painted>100, `${width}px ${canvas} must contain rendered pixels`);
        if(chapter===2) assert.notEqual(pixels.digest,previousPixels,"Blender frames must change while scrolling");
        if(chapter===1) previousPixels=pixels.digest;
        assert.equal(await page.locator(".storyChapter:not([inert])").count(),1,"Only the current motion chapter is interactive");
        await page.screenshot({path:path.join(output,`link-story-${width}-${chapter}.png`)});
      }
      await page.locator('[data-story-target="2"]').click();
      await page.waitForFunction(()=>document.getElementById("prediction").dataset.stage==="2");
      await page.locator("#storyMotionToggle").click();
      assert.equal(await page.locator(".story-enhanced").count(),0,"Reduce motion returns all text to normal document flow");
      assert.equal(await page.locator(".storyChapter:not([inert])").count(),3);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    }
    await page.emulateMedia({reducedMotion:"reduce"});
    await page.reload();
    assert.equal(await page.locator(".story-enhanced").count(),0);
    assert.equal(await page.locator("#heroVideo").evaluate(video=>video.paused),true);
    const noScript=await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:844}});
    const staticPage=await noScript.newPage();
    await staticPage.goto(base);
    assert.equal(await staticPage.locator(".storyChapter").count(),3);
    assert.ok(await staticPage.locator('[data-chapter="2"]').isVisible());
    await noScript.close();
    assert.deepEqual([...new Set(brokenAssets)], [], "no missing public assets");
    assert.deepEqual(errors, [], "no page script exceptions");
    assert.deepEqual(overflow, [], "no horizontal page overflow");
    console.log(JSON.stringify({ pages: pages.length, widths: [1440, 1024, 390, 320], screenshots, forms: "demo/pilot failure and success; invite activation", output }, null, 2));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
