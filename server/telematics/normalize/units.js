function fToC(value) {
  if (value == null) return null;
  return (Number(value) - 32) * (5 / 9);
}

function cToF(value) {
  if (value == null) return null;
  return Number(value) * (9 / 5) + 32;
}

function mphToKph(value) {
  if (value == null) return null;
  return Number(value) * 1.60934;
}

function kphToMph(value) {
  if (value == null) return null;
  return Number(value) / 1.60934;
}

function milesToKm(value) {
  if (value == null) return null;
  return Number(value) * 1.60934;
}

function kmToMiles(value) {
  if (value == null) return null;
  return Number(value) / 1.60934;
}

function gphToLph(value) {
  if (value == null) return null;
  return Number(value) * 3.78541;
}

module.exports = {
  fToC,
  cToF,
  mphToKph,
  kphToMph,
  milesToKm,
  kmToMiles,
  gphToLph
};
