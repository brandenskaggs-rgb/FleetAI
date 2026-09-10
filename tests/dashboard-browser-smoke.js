// Isolated browser fixtures: never connects to Railway or reads .env credentials.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");
const output = path.join(root, "artifacts", "ui", "audit-20260908");
const fixture = require('./dashboard-fixtures').createFixtures({catalogOnly:process.argv.includes('--serve')});
const {records} = fixture;
const serve = process.argv.includes('--serve');
if(serve && process.env.NODE_ENV==='production')throw new Error('The synthetic design preview must not run in production.');
async function checkNewWorkspace(page, fixture, output) {
  await page.setViewportSize({width:1440,height:960});
  await page.evaluate(()=>window.renderRoute('telemetry'));
  await page.selectOption('#telemetryVehicleSelect','UNIT-214');
  const emit=async (vehicleId,engine,extras={})=>page.evaluate(({vehicleId,engine,extras})=>{
    const stream=window.testStreams.find(s=>s.url.includes('/telemetry/stream'));
    stream.onmessage({data:JSON.stringify({vehicleId,ts:new Date().toISOString(),busDataActive:true,readingCount:6,metrics:{engine,vehicle:{speedKph:80},electrical:{batteryVoltageV:13.8}},...extras})});
  },{vehicleId,engine,extras});
  const engine={coolantTempC:90,rpm:1500,actualTorquePct:50,referenceTorqueNm:2000};
  await emit('UNIT-214',engine);
  assert.equal(await page.textContent('#liveCoolant'),'194');
  assert.equal(await page.textContent('#liveHorsepower'),'210.6');
  assert.equal(await page.textContent('#liveTorque'),'737.6');
  assert.equal(await page.textContent('#liveSpeed'),'49.7');
  await emit('UNIT-308',{coolantTempC:20,rpm:200});
  assert.equal(await page.textContent('#liveCoolant'),'194','other vehicles cannot replace selected readings');
  await emit('UNIT-214',{coolantTempC:91,rpm:1550,actualTorquePct:52,referenceTorqueNm:2000});
  await page.waitForTimeout(300);
  const chart=await page.evaluate(()=>{
    const canvas=document.querySelector('#coolantChart'),chart=Chart.getChart(canvas);
    const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    let colored=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i+3]&&pixels[i+2]>pixels[i]+40)colored++;
    return {unit:chart.options.scales.y.title.text,points:chart.data.datasets[0].data,colored};
  });
  assert.equal(chart.unit,'\u00b0F');assert.ok(chart.points.some(p=>p.y===195.8));assert.ok(chart.colored>10,'coolant trace must render real canvas pixels');
  await page.waitForFunction(()=>document.querySelector('#telemetrySensorGrid').textContent.includes('176'));
  await page.click('#btnAllSensors');
  assert.equal(await page.locator('.sensorReading').count(),fixture.sensorReadings.length,'every returned sensor is visible, including new groups');
  await page.fill('#sensorSearch','coolant');
  assert.equal(await page.locator('.sensorReading').count(),1);
  await page.fill('#sensorSearch','');await page.selectOption('#sensorFilter','stale');
  assert.equal(await page.locator('.sensorReading').count(),1);
  await page.selectOption('#sensorFilter','reporting');
  assert.equal(await page.locator('.sensorReading').count(),2);
  await page.selectOption('#sensorFilter','unsupported');
  assert.equal(await page.locator('.sensorReading').count(),fixture.sensorReadings.length-3);
  await page.selectOption('#sensorFilter','all');
  await page.screenshot({path:path.join(output,'all-sensors-1440.png'),fullPage:true});
  await page.locator('.main').evaluate(el=>el.scrollTop=0);
  await page.screenshot({path:path.join(output,'telemetry-1440.png'),fullPage:true});
  await emit('UNIT-214',{coolantTempC:90,rpm:1500,engineLoadPct:85});
  assert.equal(await page.textContent('#liveHorsepower'),'--','load is not a horsepower measurement');
  await emit('UNIT-214',engine,{busDataActive:false});
  assert.equal(await page.textContent('#liveCoolant'),'--');
  await page.selectOption('#workspaceVehicleSelect','UNIT-308');
  assert.equal(await page.textContent('#liveRpm'),'--','vehicle switch clears old values');
  await page.evaluate(()=>window.renderRoute('telemetry-history'));
  await page.selectOption('#historyMetricSelect','coolant_temp');
  await page.click('#btnLoadHistory');
  await page.waitForFunction(()=>document.querySelector('#historyRows').textContent.includes('176'));
  assert.match(await page.textContent('#historyRows'),/\u00b0F/);
  await page.evaluate(()=>window.renderRoute('pairing'));
  await page.waitForSelector('#btnGeneratePairCode');
  await page.selectOption('#pairVehicleSelect','UNIT-214');
  await page.selectOption('#pairDriverSelect','DRIVER-A');
  await page.click('#btnGeneratePairCode');
  await page.waitForFunction(()=>document.querySelector('#pairingCodeValue').textContent==='TEST42');
  assert.equal(await page.textContent('#pairingPinValue'),'123456');
  assert.deepEqual(fixture.requests.find(r=>r.key==='/api/pairing/generate').payload,{vehicleId:'UNIT-214',driverId:'DRIVER-A'});
  fixture.controls.pairConflict=true;
  await page.click('#btnGeneratePairCode');
  await page.waitForFunction(()=>document.querySelector('#pairingDebugError').textContent.includes('already exists'));
  assert.equal(await page.locator('#pairingDebugError').isVisible(),true,'conflicts are not hidden in diagnostics');
  fixture.controls.pairConflict=false;
  await page.click('[data-expire-pair="TEST-PAIR"]');
  await page.waitForFunction(()=>document.querySelector('#pendingPairingRows').textContent.includes('No pending'));
  await page.click('[data-replace-vehicle="UNIT-214"]');
  await page.waitForFunction(()=>document.querySelector('#pairingCodeValue').textContent==='NEXT42');
  assert.equal(await page.textContent('#pairingPinValue'),'654321');
  assert.equal(await page.locator('#pairingDebugError').isVisible(),false,'successful replacement clears the old conflict');
  assert.deepEqual(fixture.requests.find(r=>r.key==='/api/pair-code/replace').payload,{vehicleId:'UNIT-214',driverId:'DRIVER-A'});
  await page.locator('.main').evaluate(el=>el.scrollTop=0);
  await page.screenshot({path:path.join(output,'pairing-1440.png'),fullPage:true});
  for(const width of [1024,390]){
    await page.setViewportSize({width,height:960});
    assert.ok(await page.evaluate(()=>document.querySelector('.main').scrollWidth-document.querySelector('.main').clientWidth)<=1);
    await page.screenshot({path:path.join(output,`pairing-${width}.png`),fullPage:true});
  }
  await page.setViewportSize({width:1440,height:960});
  await page.evaluate(()=>window.renderRoute('vehicles'));await page.waitForSelector('#btnAddVehicle');
  await page.click('#btnAddVehicle');await page.fill('#newVehId','TEST-999');await page.fill('#newVehName','Test unit');await page.fill('#newVehVin','1XPBD49X1XD123456');
  await page.screenshot({path:path.join(output,'add-vehicle-1440.png'),fullPage:true});
  await page.click('#btnSaveVehicle');await page.waitForFunction(()=>document.querySelector('#vehicleActionStatus').textContent.includes('added'));
  assert.equal(fixture.vehicles.length,3);
  await page.evaluate(()=>window.renderRoute('drivers'));await page.waitForSelector('#btnAddDriver');
  await page.click('#btnAddDriver');await page.fill('#newDrvFirst','Taylor');await page.fill('#newDrvLast','Test');await page.fill('#newDrvPhone','5550102');
  await page.click('#btnSaveDriver');await page.waitForFunction(()=>document.querySelector('#view-drivers').textContent.includes('Taylor'));
  assert.equal(fixture.drivers.length,2);
  await page.evaluate(()=>window.renderRoute('advisor'));await page.waitForTimeout(200);
  await page.screenshot({path:path.join(output,'advisor-1440.png'),fullPage:true});
  await page.evaluate(()=>window.renderRoute('safety'));
  assert.match(await page.textContent('#view-safety'),/not available/);
  assert.equal(await page.locator('#view-safety .commandMetric__value').count(),0,'unconnected coaching cannot manufacture zero counts');
  await page.evaluate(()=>window.renderRoute('addons'));
  await page.waitForFunction(()=>document.querySelector('#addonEntitlements').textContent.includes('Not enabled'));
  assert.doesNotMatch(await page.textContent('#addonEntitlements'),/Active/);
}
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if(serve && pathname==='/api/telemetry/stream'){
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
    let sample=0;
    const emit=()=>{
      for(const vehicleId of ['UNIT-214','UNIT-308']){
        const phase=sample/10+(vehicleId==='UNIT-308'?1:0);
        res.write('data: '+JSON.stringify({vehicleId,ts:new Date().toISOString(),busDataActive:true,readingCount:7,
          deviceDiagnostics:{appVersion:'SYNTHETIC PREVIEW',adapterIdentity:'No physical adapter',detectedProtocol:'Simulated readings'},
          metrics:{engine:{coolantTempC:88+2*Math.sin(phase),rpm:1450+100*Math.sin(phase),actualTorquePct:50+5*Math.cos(phase),referenceTorqueNm:2000},vehicle:{speedKph:80+5*Math.sin(phase)},electrical:{batteryVoltageV:13.8}}
        })+'\n\n');
      }
      sample++;
    };
    emit();const interval=setInterval(emit,2000);req.on('close',()=>clearInterval(interval));return;
  }
  if(serve && pathname.startsWith('/api/')){
    let input='';for await(const chunk of req)input+=chunk;
    let payload={};try{payload=input?JSON.parse(input):{};}catch(_){res.writeHead(400).end();return;}
    const result=fixture.respond(req.url,req.method,payload);
    res.writeHead(result.status,{'Content-Type':result.contentType,'Cache-Control':'no-store'}).end(result.body);return;
  }
  if(serve && pathname==='/'){res.writeHead(302,{Location:'/ui/fleetai-dashboard.html'}).end();return;}
  if (!(pathname === "/ui/fleetai-dashboard.html" || /^\/(assets|css|ui\/js)\//.test(pathname))) { res.writeHead(404).end(); return; }
  const filename = path.resolve(root, `.${decodeURIComponent(pathname)}`);
  if (!filename.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  try {
    const types = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".woff2": "font/woff2", ".png": "image/png", ".webp":"image/webp" };
    res.setHeader("Content-Type", types[path.extname(filename)] || "application/octet-stream");
    res.end(await fs.readFile(filename));
  } catch (_) { res.writeHead(404).end(); }
});
(async () => {
  await fs.mkdir(output, { recursive: true });
  await new Promise((resolve) => server.listen(serve ? Number(process.env.DASHBOARD_PREVIEW_PORT||4176) : 0, "127.0.0.1", resolve));
  if(serve){console.log('Isolated dashboard preview: http://127.0.0.1:'+server.address().port+'/ui/fleetai-dashboard.html (synthetic data only)');return;}
  const browser = await chromium.launch();
  const errors = [];
  try {
    const page = await browser.newPage();
    page.on("pageerror", (err) => errors.push(err.message));
    await page.route("**/api/**", route => {
      const request=route.request();
      return route.fulfill(fixture.respond(request.url(),request.method(),request.postData()?request.postDataJSON():{}));
    });
    await page.route("**/customer-login.html",route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en"><title>Test login</title><h1>Sign in</h1></html>'}));
    await page.addInitScript(()=>{
      window.testStreams=[];
      window.EventSource=class {
        constructor(url){this.url=url;window.testStreams.push(this);}
        addEventListener(){} close(){}
      };
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
    await checkNewWorkspace(page, fixture, output);
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
    await page.getByRole('heading',{name:'Sign in',exact:true}).waitFor();
    assert.equal(new URL(page.url()).pathname,'/customer-login.html');
    assert.deepEqual(errors, []);
    console.log("32 routes x 3 viewports passed. Pairing create/conflict/revoke/replace, vehicle/driver forms, DVIR/dispatch/parts, units, canvas pixels, selected-vehicle isolation, session redirect and navigation passed. Synthetic fixtures only; no production writes.");
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((err) => { console.error(err); server.close(); process.exitCode = 1; });
