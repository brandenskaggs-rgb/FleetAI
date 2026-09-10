const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

assert(!source.includes('app.use("/", express.static(SITE_ROOT))'), "repository root must never be mounted as static content");
for (const directory of ["backend", "db", "deploy", "docs", "prisma", "telemetry", "tests"]) {
  assert(source.includes(directory), `static source deny policy must cover ${directory}`);
}
assert(source.includes("PUBLIC_ROOT_FILES"), "public root files must use an explicit allowlist");
assert(/app\.get\("\/admin\/debug\.html", requireSuperAdmin/.test(source), "admin diagnostics must require superadmin access");
assert(/app\.get\("\/index\.html"[\s\S]*?res\.redirect\(301, "\/"\)/.test(source), "legacy index.html links must redirect to the canonical homepage");

console.log("Static source exposure tests passed");
