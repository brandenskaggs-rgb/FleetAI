const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();

function listHtmlFiles() {
  const results = [];
  function walk(dir) {
    const base = path.basename(dir);
    if (base === "node_modules" || base === ".git" || base === ".gradle" || base === "build") return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.forEach((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".html")) results.push(p);
    });
  }
  walk(ROOT);
  return results;
}

function readText(p) {
  return fs.readFileSync(p, "utf8");
}

function isExternal(link) {
  return /^https?:\/\//i.test(link) || /^mailto:/i.test(link) || /^tel:/i.test(link) || link.startsWith("#");
}

function stripQueryAndHash(href) {
  // Strip query string and hash fragment before resolving to filesystem path
  return href.split("?")[0].split("#")[0];
}

function resolvePath(fromFile, href) {
  const clean = stripQueryAndHash(href);
  if (!clean) return null;
  if (clean.startsWith("/")) return path.join(ROOT, clean.replace(/^\//, ""));
  return path.resolve(path.dirname(fromFile), clean);
}

function collectJsSources() {
  const files = [];
  ["js", "ui/js", "ui"].forEach((dir) => {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) return;
    const entries = fs.readdirSync(full, { withFileTypes: true });
    entries.forEach((e) => {
      if (e.isFile() && e.name.endsWith(".js")) files.push(path.join(full, e.name));
    });
  });
  return files.map((p) => readText(p)).join("\n");
}

function collectInlineJs(htmlText) {
  const matches = [...htmlText.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
  return matches.map((m) => m[1]).join("\n");
}

function collectFunctionNames(jsText) {
  const names = new Set();
  const fnMatches = jsText.matchAll(/function\s+([A-Za-z0-9_]+)\s*\(/g);
  for (const m of fnMatches) names.add(m[1]);
  const assignMatches = jsText.matchAll(/\b([A-Za-z0-9_]+)\s*=\s*function\b/g);
  for (const m of assignMatches) names.add(m[1]);
  const windowAssignMatches = jsText.matchAll(/\bwindow\.([A-Za-z0-9_]+)\s*=\s*(?:async\s+)?function\b/g);
  for (const m of windowAssignMatches) names.add(m[1]);
  const arrowMatches = jsText.matchAll(/\b([A-Za-z0-9_]+)\s*=\s*\([^)]*\)\s*=>/g);
  for (const m of arrowMatches) names.add(m[1]);
  return names;
}

function extractCalledNames(code) {
  const names = [];
  const safeGlobals = new Set([
    "alert",
    "confirm",
    "document.getElementById",
    "window.location.replace",
    "window.location.assign"
  ]);
  const calls = code.matchAll(/(?:^|[^\w$.])((?:window\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g);
  for (const match of calls) {
    let name = match[1] || "";
    if (!name) continue;
    if (safeGlobals.has(name)) continue;
    if (name.startsWith("window.")) name = name.slice("window.".length);
    if (safeGlobals.has(name)) continue;
    names.push(name);
  }
  return names;
}

function main() {
  const htmlFiles = listHtmlFiles();
  const errors = [];
  const warnings = [];

  const jsBundle = collectJsSources();

  htmlFiles.forEach((file) => {
    const html = readText(file);
    const inlineJs = collectInlineJs(html);
    const fnNames = collectFunctionNames(jsBundle + "\n" + inlineJs);

    const hrefs = [...html.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]);
    const srcs = [...html.matchAll(/src=["']([^"']+)["']/gi)].map((m) => m[1]);
    const links = hrefs.concat(srcs);

    links.forEach((link) => {
      if (!link || isExternal(link)) return;
      if (link.startsWith("javascript:")) return;
      const target = resolvePath(file, link);
      if (!target) return;
      if (!fs.existsSync(target)) {
        errors.push(`Missing link target: ${link} (from ${path.relative(ROOT, file)})`);
      }
    });

    const onclicks = [...html.matchAll(/onclick=["']([^"']+)["']/gi)].map((m) => m[1]);
    onclicks.forEach((code) => {
      extractCalledNames(code).forEach((name) => {
        if (!fnNames.has(name)) {
          warnings.push(`Missing onclick function: ${name} (from ${path.relative(ROOT, file)})`);
        }
      });
    });
  });

  errors.forEach((e) => console.error(`[link-audit] ${e}`));
  warnings.forEach((w) => console.warn(`[link-audit] ${w}`));

  if (errors.length) process.exit(1);
  console.log(`[link-audit] ok (${htmlFiles.length} html files)`);
}

main();
