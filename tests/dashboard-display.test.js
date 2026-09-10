const assert = require('node:assert/strict');
const test = require('node:test');
const display = require('../ui/js/dashboard-display');

test('Fahrenheit display preserves SI input and missingness', () => {
  assert.equal(display.fahrenheit(0),32);
  assert.equal(display.fahrenheit(100),212);
  assert.equal(display.fahrenheit(-40),-40);
  for(const value of [null,undefined,'',false,true,'invalid',Infinity])assert.equal(display.fahrenheit(value),null);
  const source={value:90};display.metricValue('coolant_temp',source.value);assert.equal(source.value,90);
});
test('speed uses the existing km/h contract without double conversion', () => {
  assert.equal(display.metricValue('speed',160.9344),100);
  assert.equal(display.metricValue('speed',null),null);
});
test('actual torque and reference torque produce labeled mechanical estimates', () => {
  const frame={busDataActive:true,metrics:{engine:{actualTorquePct:50,referenceTorqueNm:2000,rpm:1500}}};
  const output=display.engineOutput(frame);
  assert.equal(output.torqueNm,1000);
  assert.ok(Math.abs(output.torqueLbFt-737.562149)<.001);
  assert.ok(Math.abs(output.horsepower-210.647257)<.001);
  assert.match(output.reason,/not a dynamometer/);
  assert.equal(frame.metrics.engine.actualTorquePct,50);
});
test('engine load and throttle never stand in for torque', () => {
  const result=display.engineOutput({metrics:{engine:{engineLoadPct:90,throttlePosPct:80,rpm:1500}}});
  assert.equal(result.torqueLbFt,null);assert.equal(result.horsepower,null);
});
test('stale, disconnected and unsynchronized inputs do not invent power', () => {
  const engine={actualTorquePct:50,referenceTorqueNm:2000,rpm:1500};
  assert.equal(display.engineOutput({busDataActive:false,metrics:{engine}}).horsepower,null);
  assert.equal(display.engineOutput({metrics:{engine},deviceDiagnostics:{metricAgesMs:{actualTorquePct:31000}}}).horsepower,null);
  const delayed=display.engineOutput({metrics:{engine},deviceDiagnostics:{metricAgesMs:{actualTorquePct:12000,rpm:0}}});
  assert.equal(delayed.torqueNm,1000);assert.equal(delayed.horsepower,null);
});
test('zero and negative torque remain real values, not missing data', () => {
  assert.equal(display.engineOutput({metrics:{engine:{actualTorquePct:0,referenceTorqueNm:2000,rpm:0}}}).horsepower,0);
  assert.ok(display.engineOutput({metrics:{engine:{actualTorquePct:-10,referenceTorqueNm:2000,rpm:1500}}}).horsepower<0);
  assert.equal(display.engineOutput({metrics:{engine:{actualTorquePct:255,referenceTorqueNm:2000,rpm:1500}}}).horsepower,null);
});
test('chart samples use chronological timestamps, reject invalid dates, preserve gaps', () => {
  const rows=[{timestamp:'2026-09-10T10:10:00Z',value:100},{timestamp:'invalid',value:4},{timestamp:'2026-09-10T10:00:00Z',value:80},{timestamp:'2026-09-10T10:00:02Z',value:null}];
  const output=display.series(rows,'coolant_temp');
  assert.equal(output.length,4);
  assert.equal(output[0].y,176);assert.equal(output[1].y,null);assert.equal(output[2].y,null);assert.equal(output[3].y,212);
  assert.ok(output.every((row,i)=>!i||row.x>output[i-1].x));
  assert.equal(rows[0].value,100);
});
test('duplicate timestamps replace readings rather than drawing artificial peaks', () => {
  const data=display.series([{timestamp:'2026-09-10T10:00:00Z',value:80},{timestamp:'2026-09-10T10:00:00Z',value:90}],'coolant_temp');
  assert.equal(data.length,1);assert.equal(data[0].y,194);
});
