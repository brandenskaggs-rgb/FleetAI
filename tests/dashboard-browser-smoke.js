// Isolated browser fixtures: never connects to Railway or reads .env credentials.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");
const output = path.join(root, "artifacts", "ui", "audit-20260908");
const vehicles = [
  { vehicleId: "UNIT-214", unitName: "Unit 214", year: 2021, make: "Freightliner", model: "Cascadia", type: "Heavy-duty", deviceId: "TABLET-214" },
  { vehicleId: "UNIT-308", unitName: "Unit 308", year: 2023, make: "Volvo", model: "VNL", type: "Heavy-duty" }
];
const drivers = [{ driverId: "DRIVER-A", firstName: "Alex", lastName: "Morgan" }];
const now = new Date().toISOString();
const health = [
  { vehicleId: "UNIT-214", healthScore: 64, risk: "Medium", subsystem: "Cooling", recommendedAction: "Review coolant trend with maintenance", updatedAt: now, topFeatures: [{ feature: "Coolant temperature", value: "Review trend" }] },
  { vehicleId: "UNIT-308", healthScore: 91, risk: "Low", subsystem: "Electrical", recommendedAction: "Continue monitoring", updatedAt: now }
];
const records = { "/api/dvir": [], "/api/dispatch/jobs": [], "/api/parts": [] };
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (!(pathname === "/ui/fleetai-dashboard.html" || /^\/(assets|css)\//.test(pathname))) { res.writeHead(404).end(); return; }
  const filename = path.resolve(root, `.${decodeURIComponent(pathname)}`);
  if (!filename.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  try {
    const types = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".woff2": "font/woff2", ".png": "image/png" };
    res.setHeader("Content-Type", types[path.extname(filename)] || "application/octet-stream");
    res.end(await fs.readFile(filename));
  } catch (_) { res.writeHead(404).end(); }
});
(async () => {
  await fs.mkdir(output, { recursive: true });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch();
  const errors = [];
  try {
    const page = await browser.newPage();
    page.on("pageerror", (err) => errors.push(err.message));
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url()), key = url.pathname;
      let body = { ok: true, data: [] };
      if (key.endsWith("/stream")) return route.fulfill({ status: 503, body: "Stream unavailable in isolated test" });
      if (key === "/api/me") body = { user: { id: "fixture-user", orgId: "FIXTURE", orgName: "Pilot fleet / Test data", displayName: "Test operator", role: "ORG_ADMIN" } };
      else if (key === "/api/vehicles") body = vehicles;
      else if (key === "/api/drivers") body = drivers;
      else if (key === "/api/ml/state") body = { ok: true, data: health };
      else if (key === "/api/work-orders") body = { data: [{ vehicleId: "UNIT-214", vehicleName: "Unit 214", title: "Inspect cooling system", status: "open", dueDate: now }] };
      else if (key === "/api/pairing/options") body = { ok: true, vehicles, drivers };
      else if (key === "/api/settings") body = { companyName: "Pilot fleet / Test data" };
      else if (key === "/api/advisor/status") body = { available: false, enabled: false };
      else if (records[key]) {
        if (route.request().method() === "POST") {
          const payload = route.request().postDataJSON();
          records[key].push({ ...payload, id: "fixture-record", submittedAt: now, defectStatus: payload.defects ? "defects_noted" : "satisfactory" });
        }
        body = { ok: true, data: records[key] };
      }
      else if (key === "/api/dot-compliance") body = { data: { dvir: { total: records["/api/dvir"].length, withDefects: 0, last24h: 1 }, hos: { status: "not_connected" } } };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    const url = `http://127.0.0.1:${server.address().port}/ui/fleetai-dashboard.html`;
    await page.goto(url);
    await page.waitForSelector("#riskQueueBody tr td");
    const routes = await page.locator(".navRoute").evaluateAll((buttons) => buttons.map((b) => b.dataset.route));
    assert.equal(routes.length, 32);
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 960 });
      await page.reload();
      await page.waitForFunction(() => document.querySelector("#headerUserName").textContent === "Test operator");
      for (const route of routes) {
        await page.evaluate((id) => window.renderRoute(id), route);
        if(width===1440) await page.locator(`.navRoute[data-route="${route}"]`).click();
        await page.waitForTimeout(60);
        assert.equal(await page.locator(".section:not(.hide)").getAttribute("id"), `view-${route}`);
        const overflow = await page.evaluate(() => {
          const main = document.querySelector(".main");
          return { page: document.documentElement.scrollWidth - innerWidth, main: main.scrollWidth - main.clientWidth };
        });
        assert(overflow.page <= 1 && overflow.main <= 1, `${route} at ${width}px overflows ${JSON.stringify(overflow)}`);
      }
      await page.evaluate(() => window.renderRoute("dashboard"));
      await page.locator("#sideNav").evaluate(el=>el.scrollTop=0);
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(output, `overview-${width}.png`), fullPage: true });
      await page.evaluate(() => window.renderRoute("dvir"));
      await page.waitForSelector("#dvirForm");
      await page.screenshot({ path: path.join(output, `inspections-${width}.png`), fullPage: true });
    }
    await page.selectOption("#dvirVehicle", "UNIT-214");
    await page.selectOption("#dvirDriver", "DRIVER-A");
    await page.locator('input[name="dvirItem"]').first().check();
    await page.fill("#dvirSignature", "Test operator");
    await page.locator('#dvirForm button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector("#dvirRows").textContent.includes("UNIT-214"));
    assert.equal(records["/api/dvir"].length, 1);
    await page.evaluate(() => window.renderRoute("dispatch"));
    await page.fill("#dispatchOrigin", "Test depot");
    await page.fill("#dispatchDestination", "Test delivery");
    await page.locator('#dispatchForm button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector("#dispatchRows").textContent.includes("Test depot"));
    assert.equal(records["/api/dispatch/jobs"].length, 1);
    await page.evaluate(() => window.renderRoute("parts-inventory"));
    await page.fill("#partName", "Test filter");
    await page.fill("#partNumber", "TEST-01");
    await page.locator('#partForm button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector("#partsRows").textContent.includes("Test filter"));
    assert.equal(records["/api/parts"].length, 1);
    await page.locator("#btnToggleNav").click();
    assert.equal(await page.locator(".sidebar").evaluate((el) => el.inert), false);
    await page.locator("#btnCloseNav").click();
    assert.equal(await page.locator(".sidebar").evaluate((el) => el.inert), true);
    assert.equal(await page.evaluate(() => [...document.fonts].some(font=>font.family.replaceAll('"','')==='Source Sans 3' && font.status==="loaded")), true);
    await page.evaluate(() => window.renderRoute("telemetry"));
    await page.selectOption("#telemetryVehicleSelect", "UNIT-308");
    await page.evaluate(() => window.loadFleetManagement());
    assert.equal(await page.inputValue("#telemetryVehicleSelect"), "UNIT-308", "fleet refresh preserves the selected vehicle");
    await page.evaluate(()=>window.renderRoute("dashboard"));
    await page.locator('[data-open-unit="UNIT-214"]').click();
    assert.equal(await page.locator('.section:not(.hide)').getAttribute('id'), 'view-telemetry');
    assert.equal(await page.inputValue('#telemetryVehicleSelect'), 'UNIT-214');
    await page.route("**/api/ml/state", route=>route.fulfill({status:503,contentType:"application/json",body:'{"error":"unavailable"}'}));
    await page.evaluate(()=>window.loadDashboard());
    assert.equal(await page.locator('#kpiActions').textContent(), '--');
    assert.match(await page.locator('#riskQueueBody').textContent(), /not been verified/);
    await page.route("**/api/auth/customer/logout", route => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' }));
    await page.locator("#btnUtilityMenu").click();
    await page.locator("#btnLogout").click();
    await page.waitForFunction(() => document.querySelector("#workspaceStatus").textContent.includes("Log out could not be confirmed"));
    assert.match(page.url(), /fleetai-dashboard\.html/);
    await page.route("**/api/me", route => route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"Unauthorized"}' }));
    await page.goto(url);
    await page.waitForURL("**/customer-login.html");
    assert.deepEqual(errors, []);
    console.log("32 routes x 3 viewport widths passed; DVIR, dispatch, parts, navigation and fonts passed. Fixtures only, no production writes.");
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((err) => { console.error(err); server.close(); process.exitCode = 1; });
