/* Display units and charts only. Ingested readings and model inputs remain SI. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FleetDisplay = api;
})(typeof window === 'undefined' ? globalThis : window, function() {
  'use strict';
  const NM_PER_LBFT = 1.3558179483314004;
  const WATTS_PER_HP = 745.6998715822702;
  const number = value => value === null || value === undefined || typeof value === 'boolean' || String(value).trim() === '' || !Number.isFinite(Number(value)) ? null : Number(value);
  const fahrenheit = value => number(value) === null ? null : number(value) * 9 / 5 + 32;
  const definitions = {
    coolant_temp: {label:'Coolant temperature',unit:'\u00b0F',convert:fahrenheit,color:'--chart-thermal'},
    rpm: {label:'Engine speed',unit:'RPM',convert:number,color:'--chart-engine'},
    speed: {label:'Road speed',unit:'mph',convert:value=>number(value)===null?null:number(value)/1.609344,color:'--chart-engine'},
    battery_voltage: {label:'Battery voltage',unit:'V',convert:number,color:'--chart-voltage'},
    engine_load: {label:'Engine load',unit:'%',convert:number,color:'--chart-engine'},
    fuel_level: {label:'Fuel level',unit:'%',convert:number,color:'--chart-voltage'},
    horsepower: {label:'Estimated engine power',unit:'hp',convert:number,color:'--chart-engine'},
    torque: {label:'Estimated engine torque',unit:'lb-ft',convert:number,color:'--chart-voltage'}
  };
  const format = (value, digits=1) => number(value) === null ? '--' : number(value).toLocaleString(undefined,{maximumFractionDigits:digits});
  function metricValue(metric, value) { return (definitions[metric]?.convert || number)(value); }
  function readEngine(frame, keys) {
    const engine = frame?.metrics?.engine || frame?.signals?.engine || frame?.metrics || frame?.signals || frame || {};
    for (const key of keys) {
      const value = number(engine[key]);
      const age = number(frame?.deviceDiagnostics?.metricAgesMs?.[key]);
      if (value !== null && (age === null || age <= 30000)) return {value,age};
    }
    return {value:null,age:null};
  }
  function engineOutput(frame) {
    const unavailable = reason => ({torqueNm:null,torqueLbFt:null,horsepower:null,reason});
    if (frame?.busDataActive === false) return unavailable('Vehicle data is offline.');
    const actual = readEngine(frame,['actualTorquePct','torquePct']);
    const reference = readEngine(frame,['referenceTorqueNm']);
    const rpm = readEngine(frame,['rpm','engineRpm']);
    if (actual.value===null || reference.value===null || reference.value<=0) return unavailable('Requires actual torque and ECU reference torque.');
    // OBD/J1939 actual torque is decoded percent, not load or accelerator position.
    if (actual.value < -125 || actual.value > 125) return unavailable('Torque reading is outside the supported decoded range.');
    const torqueNm = actual.value / 100 * reference.value;
    const synchronized = actual.age===null || rpm.age===null || Math.abs(actual.age-rpm.age)<=5000;
    const validRpm = rpm.value!==null && rpm.value>=0 && synchronized;
    return {
      torqueNm, torqueLbFt:torqueNm/NM_PER_LBFT,
      horsepower:validRpm ? torqueNm*rpm.value*2*Math.PI/60/WATTS_PER_HP : null,
      reason:validRpm?'Calculated from ECU torque and RPM; not a dynamometer measurement.':'Torque available. Power requires a current, synchronized RPM reading.'
    };
  }
  function series(records, metric, gapMs=300000) {
    const points = new Map();
    for (const row of records) {
      const x = new Date(row.timestamp || row.ts).getTime();
      if (!Number.isFinite(x)) continue;
      points.set(x,{x,y:metricValue(metric,row.value)});
    }
    const sorted = [...points.values()].sort((a,b)=>a.x-b.x), result=[];
    sorted.forEach((point,i)=>{
      if(i && point.x-sorted[i-1].x>gapMs) result.push({x:sorted[i-1].x+1,y:null});
      result.push(point);
    });
    return result;
  }
  const charts = new WeakMap();
  function chart(canvas, records, metric, gapMs=300000) {
    if (!canvas || typeof Chart==='undefined') return;
    const definition=definitions[metric] || definitions.rpm;
    const styles=getComputedStyle(document.documentElement);
    const color=styles.getPropertyValue(definition.color).trim();
    const points=series(records,metric,gapMs);
    if(canvas.parentElement)canvas.parentElement.dataset.empty=String(!points.some(point=>point.y!==null));
    let existing=charts.get(canvas);
    if(existing && canvas.dataset.chartMetric!==metric){existing.destroy();charts.delete(canvas);existing=null;}
    canvas.dataset.chartMetric=metric;
    const timeLabel=value=>{
      const span=points.length>1?points[points.length-1].x-points[0].x:0;
      return span>86400000?new Date(value).toLocaleDateString([],{month:'short',day:'numeric'}):new Date(value).toLocaleTimeString([],{hour:'numeric',minute:'2-digit',...(span<120000?{second:'2-digit'}:{})});
    };
    if(existing){existing.data.datasets[0].data=points;existing.data.datasets[0].pointRadius=points.filter(p=>p.y!==null).length===1?3:0;existing.data.datasets[0].label=definition.label;existing.data.datasets[0].borderColor=color;existing.options.scales.y.title.text=definition.unit;existing.options.scales.x.ticks.callback=timeLabel;existing.update('none');return;}
    const instance=new Chart(canvas,{
      type:'line',data:{datasets:[{label:definition.label,data:points,borderColor:color,backgroundColor:color,borderWidth:2,pointRadius:points.filter(p=>p.y!==null).length===1?3:0,pointHitRadius:14,pointHoverRadius:4,tension:0,spanGaps:false}]},
      options:{responsive:true,maintainAspectRatio:false,animation:false,parsing:false,normalized:true,
        interaction:{mode:'nearest',intersect:false,axis:'x'},
        plugins:{legend:{display:false},tooltip:{displayColors:false,callbacks:{title:items=>new Date(items[0].parsed.x).toLocaleString(),label:item=>`${format(item.parsed.y)} ${definition.unit}`}}},
        scales:{x:{type:'linear',border:{display:false},grid:{display:false},ticks:{maxTicksLimit:5,color:styles.getPropertyValue('--muted'),font:{family:'Source Sans 3',size:12},callback:timeLabel}},
          y:{border:{display:false},grid:{color:styles.getPropertyValue('--divider')},title:{display:true,text:definition.unit,color:styles.getPropertyValue('--muted')},ticks:{maxTicksLimit:5,color:styles.getPropertyValue('--muted'),font:{family:'Source Sans 3',size:12}}}}
      }
    });
    charts.set(canvas,instance);
  }
  return {number,fahrenheit,format,definitions,metricValue,engineOutput,series,chart};
});
