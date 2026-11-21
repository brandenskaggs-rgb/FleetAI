const test=require("node:test"),assert=require("node:assert/strict");
const {selectPredictionFaultEvidence}=require("../server/services/faultEvidence");
const {confirmedPredictionIncident,recordIncidents}=require("../server/services/diagnosticIncident");
const {makeScanReport}=require("../server/services/scanEvidenceReport");
const {registerDiagnosticsRoutes}=require("../server/routes/diagnosticsRoutes");
const db=require("../server/db");
const at=new Date("2026-11-18T19:00:00Z");
test("health reflects corroborated findings, not unconfirmed scores; never penalizes twice",()=>{
  const merge=require("../server/lib/mlMerge").mergePythonAndNodePrediction;
  const node={healthScore:86};
  const py={riskProbability:0.6,stageSystem:{confirmed:true}};
  assert.equal(merge(node,py).healthScore,46);
  assert.equal(merge(node,{...py,stageSystem:{confirmed:true,stage3:{verdict:"DISMISS"}}}).healthScore,86);
  assert.equal(merge(node,{riskProbability:.6,dtcAnalysis:{risk_score:.5}}).lineage.healthDecision.basis,"model_with_ecu_fault");
  assert.equal(merge({healthScore:35},py).healthScore,35);
  assert.equal(merge({}, {riskProbability:null}).healthScore,null);
});
test("partial modes retain recent positive evidence, not superseded, permanent or expired codes",()=>{
  const row=(offset,pending)=>({raw:{obdFaultRead:{capturedAt:new Date(+at+offset).toISOString(),pending,confirmed:null,permanent:["P0430"]}}});
  const rows=[row(-50000,["P0420"]),row(0,null)];
  assert.deepEqual(selectPredictionFaultEvidence(rows,null,+at).codes,["P0420"]);
  assert.deepEqual(selectPredictionFaultEvidence([...rows,row(0,[])],null,+at).codes,[]);
  assert.deepEqual(selectPredictionFaultEvidence(rows,null,+at+130000).codes,[]);
});
test("permanent-only evidence cannot notify; delayed or rejected model findings cannot notify",async()=>{
  await recordIncidents({}, {codes:[{code:"P0430",codeStatus:"permanent"}]});
  const p={evidenceThrough:at.toISOString(),predictionSource:"python_ml_ensemble",stageSystem:{confirmed:true}};
  assert.ok(confirmedPredictionIncident(p,+at));
  for(const patch of [{insufficientData:true},{insufficientHistory:true},{predictionSource:"node_fallback"},
    {stageSystem:{confirmed:false}},{stageSystem:{confirmed:true,stage3:{verdict:"DISMISS"}}}])
    assert.equal(confirmedPredictionIncident({...p,...patch},+at),null);
  assert.equal(confirmedPredictionIncident(p,+at+130000),null);
});
test("history queries positives separately so hundreds of partial rows cannot bury them",async t=>{
  const routes={}; const app={get:(k,...a)=>routes[k]=a.at(-1),post(){}};
  registerDiagnosticsRoutes(app,{sanitizeString:s=>s,requireEmployeeOrCustomerApi(){}});
  t.mock.method(db,"getVehicleOrgId",async()=>"A");
  t.mock.method(db,"listDiagnosticScans",async(v,o)=>{
    assert.equal(o.orgId,"A");assert.equal(v,"car");
    return o.positiveOnly?[{id:"first",scannedAt:at,createdAt:at,codes:[{code:"P0430",known:false,codeStatus:"permanent"}]}]
      :[{scannedAt:at,summary:{obdFaultRead:{capturedAt:at.toISOString()}}}];
  });
  await routes["/api/dtc-history"]({query:{vehicleId:"car"},customer:{orgId:"A"}},{json(body){
    assert.equal(body.diagnosticStatus.completeness,"partial");assert.match(body.data[0].description,/bank 2/);
  }},e=>{throw e;});
});
test("mechanic report uses capture window, actual readings, tenant and exact scan",async()=>{
  const prisma={diagnosticScan:{findFirst:async({where})=>{
    assert.equal(where.vehicle.orgId,where.orgId);
    return where.orgId==="A"?{id:"scan",vehicleId:"car",codes:[{code:"P0420"}],scannedAt:at,createdAt:new Date(+at+7200000)}:null;
  }},telemetrySample:{findMany:async({where})=>{
    assert.equal(where.vehicleId,"car");assert.equal(where.orgId,"A");assert.equal(+where.ts.gte,+at-60000);
    assert.equal(+where.ts.lte,+at+60000);return [{ts:at,metrics:{rpm:0,transmissionTempC:null,ltft1:-3.13}}];
  }}};
  assert.equal((await makeScanReport(prisma,{orgId:"A",vehicleId:"car"},at)).subarray(0,5).toString(),"%PDF-");
  assert.equal(await makeScanReport(prisma,{orgId:"B",vehicleId:"car"},at),null);
});
