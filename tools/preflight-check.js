const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const SPEC_DIR = path.join(ROOT, "spec", "config");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function fail(msg) {
  console.error(`[preflight] ${msg}`);
  process.exitCode = 1;
}

function ok(msg) {
  console.log(`[preflight] ${msg}`);
}

function fileExists(p) {
  try { return fs.existsSync(p); } catch (_) { return false; }
}

function loadText(p) {
  return fs.readFileSync(p, "utf8");
}

function listServerSourceFiles() {
  const out = [];
  const roots = [
    path.join(ROOT, "server.js"),
    path.join(ROOT, "server")
  ];
  for (const entry of roots) {
    if (!fileExists(entry)) continue;
    const stat = fs.statSync(entry);
    if (stat.isFile()) {
      out.push(entry);
      continue;
    }
    const stack = [entry];
    while (stack.length) {
      const current = stack.pop();
      const items = fs.readdirSync(current, { withFileTypes: true });
      for (const item of items) {
        const full = path.join(current, item.name);
        if (item.isDirectory()) {
          stack.push(full);
        } else if (item.isFile() && full.endsWith(".js")) {
          out.push(full);
        }
      }
    }
  }
  return Array.from(new Set(out));
}

function normalizePathPattern(p) {
  return String(p || "").replace(/:[A-Za-z0-9_]+/g, "[^\"'`]+?");
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRouteRegex(method, routePath) {
  const parts = String(routePath || "").split(/:[A-Za-z0-9_]+/g).map((part) => escapeRegex(part));
  const pathPattern = parts.join("[^\"'`]+");
  const methodPattern = method.toLowerCase() === "all"
    ? "all"
    : `${method.toLowerCase()}|all`;
  return new RegExp(`\\b(?:app|router)\\.(?:${methodPattern})\\s*\\(\\s*[\"\'\`]${pathPattern}[\"\'\`]`, "m");
}

function buildTextCorpus(files) {
  return files.map((file) => ({ file, text: loadText(file) }));
}

function routeExists(corpus, method, routePath) {
  const matcher = buildRouteRegex(method, routePath);
  return corpus.some(({ text }) => matcher.test(text));
}

function checkUiFiles() {
  const uiContract = readJson(path.join(SPEC_DIR, "ui_files_contract.json"));
  (uiContract.uiFiles || []).forEach((rel) => {
    const full = path.join(ROOT, rel);
    if (!fileExists(full)) fail(`Missing UI file: ${rel}`);
  });
  ok("UI files contract ok");
}

function checkStaticPaths() {
  const paths = readJson(path.join(SPEC_DIR, "static_paths_contract.json"));
  (paths.staticRoots || []).forEach((p) => {
    const full = path.join(ROOT, p.replace(/^\//, ""));
    if (!fileExists(full)) fail(`Missing static root: ${p}`);
  });
  ok("Static paths contract ok");
}

function checkRoutes() {
  const routes = readJson(path.join(SPEC_DIR, "api_routes_contract.json"));
  const corpus = buildTextCorpus(listServerSourceFiles());
  (routes.routes || []).forEach((r) => {
    if (!routeExists(corpus, r.method, r.path)) {
      fail(`Route missing in server source: ${r.method} ${r.path}`);
    }
  });
  ok("API routes contract ok");
}

function checkWatchdogContract() {
  const watchdog = readJson(path.join(SPEC_DIR, "watchdog_contract.json"));
  if (!Array.isArray(watchdog.endpoints)) {
    fail("watchdog_contract.json missing endpoints array");
    return;
  }
  ok("Watchdog contract ok");
}

function checkUiFunctions() {
  const contract = readJson(path.join(SPEC_DIR, "ui_function_contract.json"));
  (contract.functions || []).forEach((f) => {
    const files = f.files || [];
    const name = f.name;
    let found = false;
    files.forEach((rel) => {
      const full = path.join(ROOT, rel);
      if (!fileExists(full)) return;
      const text = loadText(full);
      const patterns = [
        new RegExp(`function\\s+${name}\\b`),
        new RegExp(`\\b${name}\\s*=\\s*function\\b`),
        new RegExp(`\\b${name}\\s*=\\s*\\(`),
        new RegExp(`window\\.${name}\\b`)
      ];
      if (patterns.some((re) => re.test(text))) found = true;
    });
    if (!found) fail(`UI function missing: ${name}`);
  });
  ok("UI function contract ok");
}

function checkRequiredAssets() {
  const required = [
    "tools/watchdog.js"
  ];
  required.forEach((rel) => {
    const full = path.join(ROOT, rel);
    if (!fileExists(full)) fail(`Missing required file: ${rel}`);
  });
  ok("Required assets ok");
}

function main() {
  const required = [
    "api_routes_contract.json",
    "static_paths_contract.json",
    "ui_files_contract.json",
    "ui_function_contract.json",
    "pairing_contract.json",
    "watchdog_contract.json"
  ];
  required.forEach((f) => {
    const p = path.join(SPEC_DIR, f);
    if (!fileExists(p)) fail(`Missing contract file: ${f}`);
  });

  checkUiFiles();
  checkStaticPaths();
  checkRoutes();
  checkWatchdogContract();
  checkUiFunctions();
  checkRequiredAssets();

  if (!process.exitCode) {
    ok("Preflight checks passed");
  }
}

main();
