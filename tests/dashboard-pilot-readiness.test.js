const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const db=require('../server/db');
const {registerDiagnosticsRoutes}=require('../server/routes/diagnosticsRoutes');
const {SENSORS}=require('../server/telematics/diagnostics/sensorCatalog');
const {buildSensorView}=require('../server/telematics/diagnostics/sensorCatalog');
const {normalizeMetrics}=require('../server/telematics/normalize/normalizeMetrics');
const root=path.resolve(__dirname,'..');

test('actual OBD torque survives normalization into the read-only sensor catalog',()=>{
  const normalized=normalizeMetrics({actualTorquePct:50,referenceTorqueNm:2000,rpm:1500});
  const diagnostics={supportedPids:['0162','0163'],metricAgesMs:{actualTorquePct:0}};
  const reading=buildSensorView(normalized,diagnostics).readings.find(r=>r.key==='actualTorquePct');
  assert.equal(reading.value,50);assert.equal(reading.pid,'0162');assert.equal(reading.supported,true);
  diagnostics.metricAgesMs.actualTorquePct=31000;
  const stale=buildSensorView(normalized,diagnostics).readings.find(r=>r.key==='actualTorquePct');
  assert.equal(stale.value,null);assert.equal(stale.state,'stale');
  assert.equal(normalized.engine.actualTorquePct,50,'catalog rendering cannot mutate stored sensor values');
});

test('production dashboard and startup do not load the isolated preview',()=>{
  const html=fs.readFileSync(path.join(root,'ui/fleetai-dashboard.html'),'utf8');
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  assert.match(pkg.scripts.start,/node server\.js/);
  assert.doesNotMatch(pkg.scripts.start,/fixture|preview|browser-smoke/);
  assert.doesNotMatch(html,/TEST42|NEXT42|UNIT-214|Design preview|testStreams|dashboard-fixtures|EventSource\s*=/);
  assert.match(html,/new EventSource\(workspaceStreamUrl\("\/api\/telemetry\/stream"\)\)/);
  assert.match(html,/apiGet\("\/api\/fleet\/addons"\)/);
  assert.doesNotMatch(html,/No harsh events recorded|Top Offender/);
});

test('sensor handler isolates organizations and device vehicle scope',async t=>{
  const routes=new Map(),reads=[];
  const app={get:(url,...handlers)=>routes.set(url,handlers.at(-1)),post:()=>{}};
  t.mock.method(db,'getVehicleOrgId',async id=>({'CAR-A':'ORG-A','CAR-B':'ORG-B'}[id]||''));
  const sample={metrics:{engine:{rpm:900,coolantTempC:90}},ts:new Date().toISOString(),busDataActive:true};
  const telemetryLatest={get:id=>{reads.push(id);return sample;}};
  registerDiagnosticsRoutes(app,{requireEmployeeOrCustomerApi:()=>{},sanitizeString:value=>String(value||''),nowIso:()=>new Date().toISOString(),telemetryLatest,log:()=>{}});
  async function run(req){
    const res={code:200,status(value){this.code=value;return this;},json(value){this.body=value;return this;}};
    await routes.get('/api/diagnostics/sensors')({query:{},params:{},...req},res,error=>{throw error;});
    return res;
  }
  const denied=await run({customer:{orgId:'ORG-A'},query:{vehicleId:'CAR-B'}});
  assert.equal(denied.code,403);assert.deepEqual(reads,[],'unauthorized request cannot read the telemetry cache');
  const own=await run({customer:{orgId:'ORG-A'},query:{vehicleId:'CAR-A'}});
  assert.equal(own.code,200);assert.equal(own.body.vehicleId,'CAR-A');
  assert.equal(own.body.readings.length,SENSORS.length);
  assert.equal(own.body.readings.find(r=>r.key==='coolantTempC').value,90,'API remains Celsius');
  const pinned=await run({device:{orgId:'ORG-A',vehicleId:'CAR-A'},query:{vehicleId:'CAR-B'}});
  assert.equal(pinned.body.vehicleId,'CAR-A');assert.deepEqual(reads,['CAR-A','CAR-A']);
  sample.ts=new Date(Date.now()-60000).toISOString();
  const stale=await run({customer:{orgId:'ORG-A'},query:{vehicleId:'CAR-A'}});
  assert.equal(stale.body.counts.reporting,0);
  assert.equal(stale.body.readings.find(r=>r.key==='coolantTempC').value,null);
});
