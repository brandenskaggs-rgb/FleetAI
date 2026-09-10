const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require("node:path").join(__dirname, "../ui/fleetai-dashboard.html"), "utf8");
const network = source.slice(source.indexOf("    async function fetchJson("), source.indexOf("    function err("));
const numbers = source.slice(source.indexOf("    const hasNumber ="), source.indexOf("    const unwrap ="));
const context = vm.createContext({ location: { reload() {} }, fetch: null, state: { orgId: "org-a", user: { id: "user-a" } } });
context.esc = value => String(value ?? "");
vm.runInContext(network + numbers + "\nthis.formatNumber = num;", context);
vm.runInContext(source.slice(source.indexOf("    function scoreRisk("), source.indexOf("    function formatDateTime(")), context);
vm.runInContext(source.slice(source.indexOf("    function csvCell("), source.indexOf("    function csvDownload(")), context);
(async () => {
  for (const value of [null, undefined, "", " ", false]) assert.equal(context.formatNumber(value), "--");
  assert.equal(context.formatNumber(0), "0");
  for(const value of ["Not assessed", "Offline", "Unknown", "Calibrating", "Info", null]) {
    assert(!context.riskPill(value).includes('pill good'), `${value} must not imply healthy status`);
  }
  assert.match(context.riskPill(0), /pill bad/);
  assert.match(context.riskPill(90), /pill good/);
  assert.equal(context.csvCell("=SUM(1,2)"), '"\'=SUM(1,2)"');
  assert.equal(context.csvCell("  @formula"), '"\'  @formula"');
  assert.equal(context.csvCell('Unit "A"'), '"Unit ""A"""');
  for (const status of [401, 403, 409, 429, 500, 503]) {
    let requests = 0;
    context.fetch = async () => { requests++; return { status, ok: false, text: async () => '{"error":"failed"}' }; };
    await assert.rejects(context.apiPost(["/primary", "/alias"], {}));
    assert.equal(requests, 1, `HTTP ${status} must not retry writes at another endpoint`);
  }
  let requests = 0;
  context.fetch = async (_url, opts) => {
    assert.equal(opts.headers["X-Fleet-Org"], "org-a");
    assert.equal(opts.headers["X-Fleet-User"], "user-a");
    return { status: 200, ok: true, text: async () => '{"ok":true}' };
  };
  await context.apiGet("/api/vehicles");
  context.fetch = async () => { requests++; throw new Error("Connection lost after submission"); };
  await assert.rejects(context.apiPost(["/primary", "/alias"], {}));
  assert.equal(requests, 1);
  context.fetch = async () => {
    requests++;
    return requests === 2 ? { status: 404, ok: false, text: async () => "{}" } : { status: 201, ok: true, text: async () => '{"ok":true}' };
  };
  assert.equal((await context.apiPost(["/primary", "/alias"], {})).ok, true);
  assert.equal(requests, 3, "missing route still uses the supported alias");
  console.log("Dashboard request safety and missing-value tests passed");
})().catch((err) => { console.error(err); process.exitCode = 1; });
