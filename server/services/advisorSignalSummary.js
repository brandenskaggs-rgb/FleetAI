// Keys here are stored TelemetrySample metrics, not dashboard display aliases.
const fahrenheit = v => v * 1.8 + 32;
const signals = [
  ["rpm","Engine speed","rpm"], ["vehicleSpeed","Road speed","km/h"], ["engineLoad","Engine load","%"],
  ["coolantTemp","Coolant temperature","F",fahrenheit], ["batteryVoltage","Module voltage","V"],
  ["ltft1","Long-term fuel trim B1","%"], ["ltft2","Long-term fuel trim B2","%"],
  ["stft1","Short-term fuel trim B1","%"], ["stft2","Short-term fuel trim B2","%"],
  ["catalystTempB1S1","Catalyst temperature B1S1","F",fahrenheit], ["catalystTempB2S1","Catalyst temperature B2S1","F",fahrenheit],
  ["fuelRailPressureGauge","Fuel rail gauge pressure","kPa"], ["transmissionTempC","Transmission fluid temperature","F",fahrenheit],
  ["transmissionGear","Reported gear",""], ["transmissionInputSpeedRpm","Transmission input speed","rpm"],
  ["transmissionOutputSpeedRpm","Transmission output speed","rpm"], ["torqueConverterSlipRpm","Converter slip","rpm"],
  ["transmissionPressureKpa","Transmission pressure","kPa"],
  ...["Fl","Fr","Rl","Rr"].map(side=>["wheelSpeed"+side+"Kph","Wheel speed "+side.toUpperCase(),"km/h"])
];

function summarizeSignals(rows) {
  return signals.map(([key,label,unit,convert=v=>v]) => {
    let count=0, min=null, max=null, latest=null, lastTime=-Infinity;
    for (const row of rows) {
      const raw=row.metrics?.[key], time=new Date(row.ts).getTime();
      if (!Number.isFinite(raw) || !Number.isFinite(time)) continue;
      const value=Number(convert(raw).toFixed(2));
      min=count ? Math.min(min,value) : value;
      max=count ? Math.max(max,value) : value;
      count++;
      if (time > lastTime) { lastTime=time; latest=value; }
    }
    return {key,label,unit,count,min,max,latest,recordedAt:count?new Date(lastTime).toISOString():null};
  });
}
module.exports={summarizeSignals};
