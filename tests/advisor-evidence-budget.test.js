const test=require("node:test");
const assert=require("node:assert/strict");
const {completeAdvisor,chatFailureMessage}=require("../server/services/advisorConversation");
const {summarizeSignals}=require("../server/services/advisorSignalSummary");
const {planAdvisorActions,buildReportArtifact}=require("../server/services/advisorAgentService");
const {sealReportPdf}=require("../server/services/advisorReportPdf");
const fs=require("node:fs"),path=require("node:path");
const input={message:"What was the coolant temperature?",sanitizeString:(s,n)=>s.slice(0,n),
  context:{selectedVehicleId:"test",sampleCoverage:{vehicleId:"test",retained:50000,reviewed:2500},
    signalSummary:[{key:"coolantTemp",latest:195,unit:"F"}],reports:Array.from({length:50},()=>({narrative:"a".repeat(15000)})),
    alerts:Array.from({length:100},(_,i)=>({id:i,explanation:"alert details ".repeat(800)}))},
  history:Array.from({length:8},()=>({role:"user",content:"old ".repeat(400)}))};
test("large fleets get bounded, valid evidence; only payload rejection retries",async()=>{
  const sizes=[];
  const result=await completeAdvisor(input,async messages=>{
    const prompt=messages[0].content, data=JSON.parse(prompt.split("Current Fleet AI context: ")[1]);
    assert.equal(data.signalSummary[0].latest,195);
    assert.equal(data.sampleCoverage.reviewed,2500);
    sizes.push(Buffer.byteLength(JSON.stringify(messages)));
    if(sizes.length===1) throw Object.assign(new Error(),{status:413});
    return {content:"ok"};
  });
  assert.equal(result.content,"ok");assert.ok(sizes[0]<19000 && sizes[1]<sizes[0]);
  for(const status of [429,401,500]) {
    let calls=0;
    await assert.rejects(completeAdvisor(input,async()=>{calls++;throw Object.assign(new Error(),{status});}));
    assert.equal(calls,1);
  }
  assert.match(chatFailureMessage({status:429}),/usage limit/);
  assert.match(chatFailureMessage({status:413}),/evidence/);
});
test("mechanic PDF uses scoped measured values, not nulls as zero or lifetime as sample window",async()=>{
  const at="2026-11-20T12:01:00Z",start="2026-11-20T12:00:00Z";
  const summary=summarizeSignals([{ts:at,metrics:{coolantTemp:90,rpm:0}},{ts:start,metrics:{coolantTemp:80,rpm:800}}]);
  const temp=summary.find(r=>r.key==="coolantTemp");
  assert.deepEqual([temp.latest,temp.min,temp.max,temp.unit,temp.count],[194,176,194,"F",2]);
  assert.equal(summary.find(r=>r.key==="rpm").latest,0);
  assert.equal(summary.find(r=>r.key==="transmissionTempC").latest,null);
  const context={organization:{id:"fixture",name:"Training fleet"},selectedVehicleId:"test",generatedAt:at,
    sampleCoverage:{vehicleId:"test",retained:100,reviewed:2,from:start,to:at},signalSummary:summary,
    inspections:{diagnosticScans:[{vehicleId:"test",scannedAt:at,codes:[{code:"P0430",codeStatus:"pending",parameter:"Catalyst efficiency below threshold, bank 2"}]}]}};
  const [action]=planAdvisorActions("Make a mechanic PDF",context);
  assert.equal(action.reportType,"mechanic");
  const artifact=buildReportArtifact({action,context,reply:"Test records only",request:"Mechanic PDF"});
  const other=buildReportArtifact({action:{...action,vehicleId:"other"},context,reply:"",request:""});
  assert.equal(other.content.sources.signalSummary,undefined);
  const sealed=await sealReportPdf({...artifact,title:"Example mechanic report - synthetic data"});
  const dir=path.join(__dirname,"../artifacts/reports");fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,"mechanic-example.pdf"),Buffer.from(sealed.content.pdf.base64,"base64"));
});
