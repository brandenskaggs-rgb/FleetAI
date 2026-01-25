/**
 * SAE J1979 PID map and polling recommendations for light-duty OBD-II
 * Used for reference and future adaptive polling on server/web if needed.
 */

const MINIMUM_SET = [
  { pid: "010C", name: "Engine RPM", bytes: 2, unit: "rpm", hz: 5, formula: "(256*A+B)/4" },
  { pid: "010D", name: "Vehicle speed", bytes: 1, unit: "kph", hz: 5, formula: "A" },
  { pid: "0105", name: "Coolant temp", bytes: 1, unit: "C", hz: 1, formula: "A-40" },
  { pid: "010F", name: "Intake air temp", bytes: 1, unit: "C", hz: 1, formula: "A-40" },
  { pid: "0142", name: "Control module voltage", bytes: 2, unit: "V", hz: 1, formula: "(256*A+B)/1000" }
];

const EXTENDED_SET = [
  { pid: "0104", name: "Engine load", bytes: 1, unit: "%", hz: 1, formula: "A*100/255" },
  { pid: "0110", name: "MAF", bytes: 2, unit: "g/s", hz: 1, formula: "(256*A+B)/100" },
  { pid: "0111", name: "Throttle position", bytes: 1, unit: "%", hz: 1, formula: "A*100/255" },
  { pid: "010B", name: "MAP", bytes: 1, unit: "kPa", hz: 1, formula: "A" },
  { pid: "0133", name: "Barometric pressure", bytes: 1, unit: "kPa", hz: 0.2, formula: "A" }
];

function discoveryCommands() {
  return ["0100", "0120", "0140", "0160", "0180"];
}

module.exports = {
  MINIMUM_SET,
  EXTENDED_SET,
  discoveryCommands
};
