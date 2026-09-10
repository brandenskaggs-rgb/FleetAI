"use strict";
// Loopback-only fixtures: no .env, database, real accounts, or provider calls.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const {chromium} = require("playwright");
const root = path.resolve(__dirname, "..");
const serve = process.argv.includes("--serve");
if (serve && process.env.NODE_ENV === "production") throw new Error("Employee fixtures cannot run in production.");
const output = path.join(root, "artifacts/ui/employee-link");
const routes = ["overview", "orgs", "leads", "invites", "billing", "features", "system-health", "audit-log", "api-keys", "users", "settings"];
const orgs = [
  {orgId:"QA-NORTH",name:"Northline Freight",status:"PILOT",fleetSizeEstimate:24,activeVehicles:2,primaryContactName:"Alex Morgan",primaryContactEmail:"alex@example.test",billingPlan:"PILOT_CORE"},
  {orgId:"QA-WEST",name:"Westfield Distribution",status:"ACTIVE",fleetSizeEstimate:48,activeVehicles:36,primaryContactName:"Jordan Lee",primaryContactEmail:"jordan@example.test"},
  {orgId:"QA-HARBOR",name:"Harbor Service Fleet",status:"LEAD",fleetSizeEstimate:12,activeVehicles:0,primaryContactEmail:"operations@example.test"}
];
const leads = [{id:"QA-LEAD",companyName:"Prairie Logistics",contactName:"Taylor Reed",contactEmail:"taylor@example.test",status:"NEW",leadType:"PILOT",fleetSize:18,createdAt:"2026-09-10T15:00:00Z",message:"Interested in a two-vehicle evaluation."}];
const audit = [
  {event:"Company created",detail:"Northline Freight entered pilot onboarding.",createdAt:"2026-09-10T14:30:00Z"},
  {event:"Customer access issued",detail:"Westfield Distribution primary contact.",createdAt:"2026-09-10T13:15:00Z"},
  {event:"Invitation created",detail:"Harbor Service Fleet setup link issued.",createdAt:"2026-09-09T20:00:00Z"}
];
const mutations = [], unexpected = [];
let role = "SUPER_ADMIN", unauthorized = false, failAccess = false;
const testPassword = "Example-only-Password-123!";
const types = {".html":"text/html; charset=utf-8",".js":"application/javascript",".css":"text/css",".svg":"image/svg+xml",".woff2":"font/woff2",".ttf":"font/ttf",".png":"image/png",".webp":"image/webp"};
async function api(req, res, url) {
  const p = url.pathname, method = req.method;
  const json = (data, status=200) => res.writeHead(status,{"Content-Type":"application/json"}).end(JSON.stringify(data));
  if (unauthorized) return json({error:"Sign in required"},401);
  let payload;
  if (method !== "GET") {
    let body = "";
    for await (const chunk of req) { body += chunk; if(body.length > 65536) return json({error:"Too large"},413); }
    payload = body ? JSON.parse(body) : {};
    mutations.push({method,path:p,payload});
  }
  if (p === "/api/employee/session") return json({employee:{role,email:"reviewer@example.test",name:"Preview operator"}});
  if (p === "/api/employee/logout") return json({ok:true});
  if (p === "/api/overview") return json({data:{mrrEstimate:1800,activeOrgs:1,activeVehicles:38,openLeads:1,recentAlerts:[{type:"Device disconnected",vehicleId:"QA-UNIT-02",explanation:"No recent bus data. Inspect the adapter connection.",createdAt:"2026-09-10T14:20:00Z"}]}});
  if (p === "/api/audit") return json({data:audit});
  if (p === "/api/orgs") {
    if(method === "POST") { const org={...payload,orgId:"QA-CREATED"};orgs.push(org);return json({data:org}); }
    return json({data:orgs});
  }
  if (/^\/api\/orgs\/[^/]+\/customer\/create$/.test(p)) return failAccess ? json({error:"Test access service unavailable"},503) : json({data:{tempPassword:testPassword}});
  if (/^\/api\/orgs\/[^/]+\/customer\/reset-password$/.test(p)) return json({data:{tempPassword:testPassword}});
  if (/^\/api\/orgs\/[^/]+\/vehicles$/.test(p)) return json({data:[{vehicleId:"QA-UNIT-02",name:"Unit 02",make:"Freightliner",model:"Cascadia",status:"ACTIVE"}]});
  if (/^\/api\/orgs\/[^/]+\/feature-flags$/.test(p)) return json({data:{cameraIntegration:false,safetyScorePack:false,compliancePack:true}});
  if (/^\/api\/orgs\/[^/]+$/.test(p) && method === "PATCH") { const org=orgs.find(o=>o.orgId===p.split('/').at(-1));Object.assign(org,payload);return json({data:org}); }
  if (p === "/api/leads") return json({data:leads});
  if (p === "/api/leads/QA-LEAD/convert") { leads[0].status="CONVERTED";return json({data:{org:orgs[0],reused:true}}); }
  if (p === "/api/invites") return json({data:method==="POST"?{token:"synthetic-invitation"}:[{orgId:orgs[0].orgId,type:"CUSTOMER",expiresAt:"2026-10-10T12:00:00Z"}]});
  if (p === "/api/employees") return json({data:method==="POST"?{...payload,tempPassword:testPassword}:[{email:"reviewer@example.test",role:"SUPER_ADMIN",isActive:true,createdAt:"2026-09-01T12:00:00Z"}]});
  if (p === "/api/health") return json({ok:true,version:"test fixture",time:"2026-09-10T15:00:00Z"});
  if (p === "/api/diagnostics") return json({modules:{advisor:true,billing:false,pairing:true},routes:[{method:"GET",path:"/api/health",available:true}]});
  if (p === "/api/admin/api-keys") return json({data:[{id:"QA-KEY",partnerName:"Test integration",tier:"partner_ml",orgId:"QA-NORTH",enabled:true}]});
  unexpected.push(`${method} ${p}`);
  return json({error:"No test fixture for this operation"},404);
}
const server = http.createServer(async (req,res) => {
  try {
    const url=new URL(req.url,"http://localhost");
    if(url.pathname.startsWith('/api/')) return await api(req,res,url);
    const relative=decodeURIComponent(url.pathname==="/"?"/employee-portal.html":url.pathname).slice(1);
    const filename=path.resolve(root,relative);
    const allowed=["employee-portal.html","employee-login.html"].includes(relative)||/^(?:css|js|ui\/js|public\/js|assets\/brand|assets\/fonts|assets\/vendor\/lucide)\//.test(relative);
    if(!allowed||!filename.startsWith(root+path.sep)||!types[path.extname(filename)])return res.writeHead(404).end();
    let body=await fs.readFile(filename);
    if(serve&&relative==="employee-portal.html")body=Buffer.from(body.toString().replace("Fleet AI / Internal","Local preview / Sample records only"));
    res.writeHead(200,{"Content-Type":types[path.extname(filename)],"Cache-Control":"no-store"}).end(body);
  } catch (_) {res.writeHead(500).end();}
});

(async()=>{
  await new Promise(resolve=>server.listen(serve?Number(process.env.EMPLOYEE_PREVIEW_PORT||4177):0,"127.0.0.1",resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  if(serve){console.log(`Employee preview: ${base} (synthetic records, no live services)`);return;}
  await fs.mkdir(output,{recursive:true});
  const browser=await chromium.launch();
  const errors=[],assetErrors=[];
  try {
    const context=await browser.newContext({reducedMotion:"reduce"});
    await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
    const page=await context.newPage();
    page.on('pageerror',e=>errors.push(e.message));
    page.on('response',r=>{if(r.status()>=400&&!new URL(r.url()).pathname.startsWith('/api/'))assetErrors.push(r.url());});
    page.on('dialog',async dialog=>{errors.push(dialog.message());await dialog.dismiss();});
    for(const width of [1920,1440,1024,390]) {
      await page.setViewportSize({width,height:1000});
      await page.goto(base,{waitUntil:'networkidle'});
      for(const route of routes) {
        if(width<981)await page.click('#employeeNavToggle');
        await page.click(`#employeeNav [data-route="${route}"]`);
        await page.waitForFunction(route=>document.querySelector(`#employeeNav [data-route="${route}"]`)?.getAttribute('aria-current')==='page',route);
        await page.waitForLoadState('networkidle');
        await page.evaluate(()=>document.fonts.ready);
        assert.equal(await page.locator(`#employeeNav [data-route="${route}"]`).getAttribute('aria-current'),'page');
        assert.ok(await page.locator('#portalView').innerText(),route);
        const size=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
        assert.ok(size.scroll<=size.width+1,`${route} overflows at ${width}: ${size.scroll}`);
        if(['overview','orgs','leads','users'].includes(route)&&[1440,390].includes(width))await page.screenshot({path:path.join(output,`${route}-${width}.png`)});
      }
    }
    await page.setViewportSize({width:1440,height:1000});
    await page.click('#employeeNav [data-route="orgs"]');
    await page.click('#orgCreateBtn');
    await page.locator('#orgCreateForm [name="name"]').fill('QA Customer');
    await page.locator('#orgCreateForm [name="primaryContactName"]').fill('Test Contact');
    await page.locator('#orgCreateForm [name="primaryContactEmail"]').fill('new@example.test');
    await page.locator('#orgCreateForm [type="submit"]').click();
    await page.waitForFunction(()=>document.querySelector('#customerTempPassword')?.textContent==='Example-only-Password-123!');
    assert.equal(await page.inputValue('#orgDetailNameInput'),'QA Customer');
    const created=mutations.find(m=>m.path==='/api/orgs'&&m.method==='POST');
    assert.equal(created.payload.createCustomerLogin,true);
    assert.ok(mutations.some(m=>m.path==='/api/orgs/QA-CREATED/customer/create'&&m.payload.email==='new@example.test'));
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:1000});
      await page.locator('#customerPasswordBlock').scrollIntoViewIfNeeded();
      const fits=await page.locator('#customerTempPassword').evaluate(el=>el.scrollWidth<=el.clientWidth&&parseFloat(getComputedStyle(el).fontSize)>=18);
      assert.ok(fits,'temporary password must wrap at a readable size');
      await page.screenshot({path:path.join(output,`credentials-${width}.png`)});
    }
    await page.setViewportSize({width:1440,height:1000});
    await page.fill('#orgDetailNotesInput','QA-only saved note');
    await Promise.all([page.waitForResponse(r=>r.request().method()==='PATCH'&&r.url().endsWith('/api/orgs/QA-CREATED')),page.click('#orgSaveBtn')]);
    await page.waitForFunction(()=>document.querySelector('#orgDetailNotesInput')?.value==='QA-only saved note');
    assert.ok(mutations.some(m=>m.method==='PATCH'&&m.path==='/api/orgs/QA-CREATED'&&m.payload.notes==='QA-only saved note'));
    failAccess=true;await page.click('#orgCreateCustomerBtn');
    await page.waitForFunction(()=>document.querySelector('.portalToast.bad')?.textContent.includes('Test access service unavailable'));
    failAccess=false;
    await page.click('#employeeNav [data-route="leads"]');
    await page.click('#leadTable button');await page.click('#leadConvertBtn');
    await page.waitForFunction(()=>document.querySelector('#orgDetailNameInput')?.value==='Northline Freight');
    assert.ok(mutations.some(m=>m.path==='/api/leads/QA-LEAD/convert'&&m.payload.status==='PILOT'));
    await page.click('#employeeNav [data-route="invites"]');
    await page.selectOption('#inviteOrgSelect','QA-NORTH');await page.click('#inviteCreateBtn');
    await page.waitForFunction(()=>document.querySelector('#inviteResultUrl')?.textContent.includes('synthetic-invitation'));
    await page.click('#employeeNav [data-route="users"]');await page.click('#employeeCreateBtn');
    await page.locator('#employeeCreateForm [name="email"]').fill('staff@example.test');
    await page.locator('#employeeCreateForm [type="submit"]').click();
    await page.waitForSelector('#employeeTempPassword');
    assert.equal(await page.textContent('#employeeTempPassword'),testPassword);
    await page.keyboard.press('Escape');
    await page.click('#employeeNav [data-route="settings"]');await page.check('#densityToggle');
    await page.reload({waitUntil:'networkidle'});assert.ok(await page.locator('body').evaluate(el=>el.classList.contains('density-compact')));
    role='SUPPORT';await page.goto(base,{waitUntil:'networkidle'});await page.click('#employeeNav [data-route="users"]');
    assert.equal(await page.locator('#employeeCreateBtn').isDisabled(),true);
    await page.setViewportSize({width:390,height:900});await page.click('#employeeNavToggle');await page.keyboard.press('Escape');
    assert.equal(await page.locator('#employeeNavToggle').getAttribute('aria-expanded'),'false');
    await page.click('#employeeSignOut');await page.waitForURL('**/employee-login.html');
    assert.ok(mutations.some(m=>m.path==='/api/employee/logout'&&m.method==='POST'));
    unauthorized=true;
    await page.goto(`${base}/employee-portal.html`,{waitUntil:'commit'});
    await page.locator('#employeeLoginForm').waitFor({state:'visible'});
    await page.waitForLoadState('networkidle');
    assert.equal(new URL(page.url()).pathname,'/employee-login.html');
    assert.deepEqual(errors,[]);assert.deepEqual(assetErrors,[]);assert.deepEqual(unexpected,[]);
    console.log('Employee portal: 11 routes x 4 widths; company/create/access/save, conversion, invite, employee credentials, role gating, logout, redirect, density and mobile navigation passed. Synthetic data only.');
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
