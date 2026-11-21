const { renderReportPdf } = require("./advisorReportPdf");
const { describeCodes } = require("./diagnosticIncident");
const { diagnosticReadStatus } = require("../telematics/diagnostics/obdFaultRead");

const signals = [
  ["rpm","Engine speed","rpm"], ["vehicleSpeed","Road speed","km/h"], ["engineLoad","Engine load","%"],
  ["coolantTemp","Coolant","F",v=>32+1.8*v], ["batteryVoltage","Module voltage","V"],
  ["ltft1","Long-term fuel trim B1","%"], ["ltft2","Long-term fuel trim B2","%"],
  ["stft1","Short-term fuel trim B1","%"], ["stft2","Short-term fuel trim B2","%"],
  ["fuelRailPressureGauge","Fuel rail pressure","kPa"], ["transmissionTempC","Transmission temperature","F",v=>32+1.8*v],
  ["transmissionGear","Transmission gear",""], ["torqueConverterSlipRpm","Converter slip","rpm"],
  ...["Fl","Fr","Rl","Rr"].map(side=>["wheelSpeed"+side+"Kph","Wheel speed "+side.toUpperCase(),"km/h"])
];
async function makeScanReport(prisma, {orgId,vehicleId}, stamp, ref=null, model=false) {
  if (!orgId || !vehicleId) return null;
  const where = { orgId,vehicleId,vehicle:{orgId} };
  const scan = model ? null : await prisma.diagnosticScan.findFirst({where:{...where,scannedAt:stamp,codeCount:{gt:0},...(ref?{id:ref}:{})},orderBy:{id:"asc"}});
  const run = model && ref ? await prisma.mlPredictionRun.findFirst({where:{...where,id:ref}}) : null;
  if (!scan && (!run || Date.parse(run.predictionJson?.evidenceThrough)!==+stamp)) return null;
  const rows = await prisma.telemetrySample.findMany({where:{...where,ts:{gte:new Date(+stamp-60000),lte:new Date(+stamp+60000)}},
    orderBy:{ts:"asc"},take:1001,select:{ts:true,metrics:true}});
  const truncated = rows.length>1000;
  const observed = rows.slice(0,1000);
  const pairedTrims = observed.flatMap(({metrics:m})=>Number.isFinite(m?.ltft1) && Number.isFinite(m?.ltft2)
    ? [m.ltft2-m.ltft1] : []).sort((a,b)=>a-b);
  const mid = Math.floor(pairedTrims.length/2);
  const bankComparison = pairedTrims.length ? "Across "+pairedTrims.length+
    " rows reporting both long-term fuel trims, the median bank 2 minus bank 1 difference was "+
    ((pairedTrims[mid]+pairedTrims[Math.floor((pairedTrims.length-1)/2)])/2).toFixed(2)+
    " percentage points. This comparison does not identify a failed part."
    : "No paired long-term fuel trim readings were available in this event window; no bank comparison was inferred.";
  const readings = signals.map(([key,label,unit,convert=v=>v])=>{
    const valid=observed.filter(row=>Number.isFinite(row.metrics?.[key]));
    const values=valid.map(row=>convert(row.metrics[key]));
    return { label, unit, value:values.length?Math.min(...values).toFixed(2)+" to "+Math.max(...values).toFixed(2):null,
      state:valid.length+" rows",recordedAt:valid.at(-1)?.ts };
  });
  const summary = scan ? "The vehicle reported "+describeCodes(scan.codes).map(c=>c.code+" ("+(c.codeStatus||"reported")+")").join(", ")+
    ". Read at "+stamp.toISOString()+"; stored on the server at "+scan.createdAt.toISOString()+". A code identifies what to investigate, not which part to replace."
    : "The model flagged an inspection pattern in data through "+stamp.toISOString()+". "+(run.predictionJson?.stageSystem?.confirmationReason||"")+" This is not a confirmed breakdown.";
  return renderReportPdf({id:scan?.id || run.id,type:"Maintenance evidence",title:"Maintenance evidence report",createdAt:new Date(),content:{
    scope:{vehicleId},summary,
    sources:{vehicleId,inspections:{diagnosticScans:scan?[{...scan,codes:describeCodes(scan.codes),diagnosticStatus:diagnosticReadStatus(scan)}]:[]},readings,
      predictions:run?[run]:[],vehicleHealth:run?[{vehicleId,healthScore:run.healthScore,confidenceStage:run.confidenceStage,updatedAt:run.createdAt}]:[],
      limitations:[bankComparison,"Sensor values are the minimum and maximum in the minute before and after the event, not an ECU freeze-frame. "+observed.length+" timestamped rows retrieved."+(truncated?" Window truncated at 1,000 rows.":""),
        "Compare the reported codes with OEM freeze-frame and module diagnostics. Absent wheel speed or transmission signals cannot rule out those faults."]}}});
}
module.exports={makeScanReport};
