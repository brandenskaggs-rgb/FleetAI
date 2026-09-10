// Synthetic, in-memory UI evidence. Never reads credentials or contacts production.
function createFixtures(options={}) {
  const now=new Date().toISOString();
  const vehicles=[
    {vehicleId:'UNIT-214',unitName:'Unit 214',year:2021,make:'Freightliner',model:'Cascadia',type:'Heavy-duty',deviceId:'TABLET-214'},
    {vehicleId:'UNIT-308',unitName:'Unit 308',year:2023,make:'Volvo',model:'VNL',type:'Heavy-duty'}
  ];
  const drivers=[{driverId:'DRIVER-A',firstName:'Alex',lastName:'Morgan'}];
  const health=[
    {vehicleId:'UNIT-214',healthScore:64,risk:'Medium',subsystem:'Cooling',recommendedAction:'Review coolant trend with maintenance',updatedAt:now,topFeatures:[{feature:'Coolant temperature',value:'Review trend'}]},
    {vehicleId:'UNIT-308',healthScore:91,risk:'Low',subsystem:'Electrical',recommendedAction:'Continue monitoring',updatedAt:now}
  ];
  const records={'/api/dvir':[],'/api/dispatch/jobs':[],'/api/parts':[]};
  const controls={pairConflict:false},requests=[];
  const sensorReadings=require('../server/telematics/diagnostics/sensorCatalog').SENSORS.map(sensor=>({...sensor,value:null,supported:false,state:'unsupported'}));
  Object.assign(sensorReadings.find(sensor=>sensor.key==='coolantTempC'),{value:80,supported:true,state:'normal'});
  Object.assign(sensorReadings.find(sensor=>sensor.key==='rpm'),{supported:true,state:'stale',stale:true});
  if(!options.catalogOnly)sensorReadings.push({key:'futureSignal',label:'Future signal',group:'new-module',value:3,supported:true,state:'normal'});
  let pending=[];
  function respond(url,method='GET',payload={}) {
    const parsed=new URL(url,'http://localhost'),key=parsed.pathname;
    requests.push({key,method,payload});
    const reply=(body,status=200)=>({status,contentType:'application/json',body:JSON.stringify(body)});
    if(key.endsWith('/stream'))return reply({error:'No physical device in design preview'},503);
    if(key==='/api/me')return reply({user:{id:'fixture-user',orgId:'FIXTURE',orgName:'Design preview / Sample data',displayName:'Test operator',role:'ORG_ADMIN'}});
    if(key==='/api/vehicles'){
      if(method==='POST')vehicles.push({...payload});
      return reply(method==='POST'?{ok:true}:vehicles);
    }
    if(key==='/api/drivers'){
      if(method==='POST')drivers.push({...payload,driverId:'DRIVER-B'});
      return reply(method==='POST'?{ok:true}:drivers);
    }
    if(key==='/api/ml/state')return reply({ok:true,data:health});
    if(key==='/api/work-orders')return reply({data:[{vehicleId:'UNIT-214',vehicleName:'Unit 214',title:'Inspect cooling system',status:'open',dueDate:now}]});
    if(key==='/api/pairing/options')return reply({ok:true,vehicles,drivers});
    if(key==='/api/pairing/generate'){
      if(controls.pairConflict)return reply({error:'A pairing already exists. Revoke it or replace the tablet.'},409);
      pending=[{id:'TEST-PAIR',...payload,expiresAt:new Date(Date.now()+600000).toISOString()}];
      return reply({pairingCode:'TEST42',driverPin:'123456',expiresAt:pending[0].expiresAt});
    }
    if(key==='/api/pairings/active')return reply({data:pending});
    if(key==='/api/pairings/debug')return reply({active:[{id:'TEST-CLAIM',vehicleId:'UNIT-214',driverId:'DRIVER-A',deviceId:'TABLET-214',status:'active',claimedAt:now}]});
    if(key==='/api/pair-code/TEST-PAIR/expire'){pending=[];return reply({ok:true});}
    if(key==='/api/pair-code/replace')return reply({pairingCode:'NEXT42',driverPin:'654321',expiresAt:new Date(Date.now()+600000).toISOString()});
    if(key==='/api/settings')return reply({companyName:'Design preview / Sample data'});
    if(key==='/api/fleet/addons')return reply({ok:true,enabledAddons:{aiAdvisor:false,cameraIntegration:false}});
    if(key==='/api/advisor/status')return reply({available:false,enabled:false});
    if(key==='/api/diagnostics/sensors')return reply({vehicleId:parsed.searchParams.get('vehicleId'),counts:{reporting:sensorReadings.filter(r=>r.value!==null).length,stale:1,unsupported:sensorReadings.filter(r=>r.supported===false).length},readings:sensorReadings});
    if(key.endsWith('/metrics/history'))return reply({data:Array.from({length:24},(_,i)=>({ts:new Date(Date.now()-(24-i)*60000).toISOString(),value:parsed.searchParams.get('metric')==='coolant_temp'?80+i*.2:1100+i*10,quality:'sample data'}))});
    if(records[key]){
      if(method==='POST')records[key].push({...payload,id:'fixture-record',submittedAt:now,defectStatus:payload.defects?'defects_noted':'satisfactory'});
      return reply({ok:true,data:records[key]});
    }
    if(key==='/api/dot-compliance')return reply({data:{dvir:{total:records['/api/dvir'].length,withDefects:0,last24h:1},hos:{status:'not_connected'}}});
    return reply({ok:true,data:[]});
  }
  return {vehicles,drivers,health,records,controls,requests,respond,sensorReadings};
}
module.exports={createFixtures};
