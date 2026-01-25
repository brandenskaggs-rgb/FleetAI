const YEAR_MAP = {
  A: 2010, B: 2011, C: 2012, D: 2013, E: 2014, F: 2015, G: 2016, H: 2017, J: 2018, K: 2019,
  L: 2020, M: 2021, N: 2022, P: 2023, R: 2024, S: 2025, T: 2026, V: 2027, W: 2028, X: 2029, Y: 2030
};

const WMI_MAP = {
  "1FA": "Ford",
  "1FB": "Ford",
  "1FZ": "Ford",
  "3FA": "Ford",
  "3HG": "Honda",
  "1HG": "Honda",
  "1GC": "Chevrolet",
  "1G1": "Chevrolet",
  "1G2": "Pontiac",
  "1N4": "Nissan",
  "5N1": "Nissan",
  "1FT": "Ford",
  "1C4": "Chrysler",
  "1C6": "RAM",
  "1D3": "Dodge",
  "2G": "General Motors",
  "2H": "Honda Canada",
  "5F": "Honda USA/Acura",
  "19U": "Acura",
  "1G6": "Cadillac",
  "SAL": "Land Rover",
  "WVW": "Volkswagen",
  "WAU": "Audi"
};

function decodeVinAttributes(vinRaw) {
  const vin = (vinRaw || "").trim().toUpperCase();
  if (vin.length !== 17) return { vin, year: null, make: null };
  const yearChar = vin[9];
  const year = YEAR_MAP[yearChar] || null;
  const wmi3 = vin.slice(0, 3);
  const make = WMI_MAP[wmi3] || null;
  return { vin, year, make };
}

module.exports = {
  decodeVinAttributes
};
