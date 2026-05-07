const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SCAN_DIRS = ["ui", "app", "js", "public", "admin"];
const ROOT_FILES = fs.readdirSync(ROOT).filter((name) => name.endsWith(".html") || name.endsWith(".css"));
const IGNORE_DIRS = new Set(["node_modules", "driver_app", "backend", "db", "tools", "telemetry", "assets", ".git"]);
const PATTERNS = [
  /http:\/\/localhost/i,
  /127\.0\.0\.1/,
  /192\.168\./,
  /0\.0\.0\.0/
];

function shouldScanFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".html" || ext === ".js" || ext === ".css";
}

function walk(dir, results) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), results);
    } else {
      const filePath = path.join(dir, entry.name);
      if (shouldScanFile(filePath)) results.push(filePath);
    }
  }
}

function scanFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const pattern of PATTERNS) {
      if (pattern.test(line)) {
        hits.push({ line: i + 1, text: line.trim(), pattern: pattern.toString() });
      }
    }
  }
  return hits;
}

const files = [];
SCAN_DIRS.forEach((dir) => {
  const full = path.join(ROOT, dir);
  if (fs.existsSync(full)) walk(full, files);
});
ROOT_FILES.forEach((file) => files.push(path.join(ROOT, file)));

let totalHits = 0;
for (const filePath of files) {
  const hits = scanFile(filePath);
  if (hits.length) {
    totalHits += hits.length;
    console.error(`Hardcoded host found: ${path.relative(ROOT, filePath)}`);
    hits.forEach((hit) => {
      console.error(`  L${hit.line}: ${hit.text}`);
    });
  }
}

if (totalHits > 0) {
  console.error(`\nFound ${totalHits} hardcoded host reference(s).`);
  process.exit(1);
}

console.log("OK: no hardcoded localhost/LAN IPs in browser-facing UI files.");
