const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createMutationQueue, trackMutationHandlers } = require("../server/middleware/mutationQueue");
const tick = () => new Promise(resolve => setImmediate(resolve));
const request = (path = "/api/write") => ({ method: "POST", path });

test("cancelled middle waiter neither blocks successors nor bypasses predecessor", async () => {
  const queue = createMutationQueue();
  const first = new EventEmitter(), cancelled = new EventEmitter(), last = new EventEmitter();
  const calls = [];
  await queue(request(), first, () => calls.push("first"));
  const pending = queue(request(), cancelled, () => calls.push("cancelled"));
  cancelled.emit("close");
  const following = queue(request(), last, () => calls.push("last"));
  await tick();
  assert.deepEqual(calls, ["first"]);
  first.emit("finish");
  await Promise.all([pending, following]);
  assert.deepEqual(calls, ["first", "last"]);
  last.emit("finish");
});

test("already destroyed requests and synchronous failures release their queue slots", async () => {
  const queue = createMutationQueue();
  const dead = Object.assign(new EventEmitter(), { destroyed: true });
  await queue(request(), dead, () => assert.fail("closed request dispatched"));
  let error;
  await queue(request(), new EventEmitter(), err => { if (err) error = err; else throw new Error("route failed"); });
  assert.equal(error.message, "route failed");
  const final = new EventEmitter();
  let called = false;
  await queue(request(), final, () => { called = true; });
  assert.equal(called, true);
  final.emit("close");
});

test("all PostgreSQL telemetry aliases bypass unrelated writes; JSON mode stays ordered", async () => {
  for (const mirror of [false, true]) {
    const queue = createMutationQueue({ telemetryJsonMirrorEnabled: mirror });
    const blocker = new EventEmitter();
    await queue(request(), blocker, () => {});
    let count = 0;
    const responses = [new EventEmitter(), new EventEmitter(), new EventEmitter()];
    const pending = ["/api/telemetry", "/api/telemetry/snapshot", "/api/telemetry/ingest"].map((path, i) =>
      queue(request(path), responses[i], () => { count++; responses[i].emit("finish"); }));
    await tick();
    assert.equal(count, mirror ? 0 : 3);
    blocker.emit("finish");
    await Promise.all(pending);
    assert.equal(count, 3);
  }
});

test("reentrant aliases do not acquire the same queue twice", async () => {
  const queue = createMutationQueue();
  const req = request(), res = new EventEmitter();
  let called = false;
  await queue(req, res, () => queue(req, res, () => { called = true; }));
  assert.equal(called, true);
  res.emit("finish");
});

test("disconnect during an async mutation retains the lock until its writes finish", async t => {
  const express = require("express"), http = require("node:http");
  const app = express(), router = express.Router();
  app.use(createMutationQueue());
  let unlock, entered;
  const barrier = new Promise(resolve => { unlock = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let claimed = false, enteredCount = 0;
  router.post("/accept", async (req, res) => {
    enteredCount++;
    if (claimed) return res.sendStatus(409);
    entered();
    await barrier;
    claimed = true;
    res.sendStatus(200);
  });
  app.use("/invite", router);
  trackMutationHandlers(app.router.stack);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => { unlock(); server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const aborted = http.request(`${base}/invite/accept`, { method: "POST" });
  aborted.on("error", () => {}); aborted.end();
  await started; aborted.destroy();
  const successor = fetch(`${base}/invite/accept`, { method: "POST" });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(enteredCount, 1, "second request must not see an unconsumed invitation");
  unlock();
  assert.equal((await successor).status, 409);
  assert.equal(enteredCount, 2);
});

test("tracked rejected handlers retain Express error handling and release successors", async t => {
  const express = require("express"), app = express();
  app.use(createMutationQueue());
  app.post("/fail", async () => { await tick(); throw new Error("expected"); });
  app.post("/ok", (req, res) => res.sendStatus(204));
  app.use(async (error, req, res, next) => { await tick(); res.status(500).json({ error: error.message }); });
  trackMutationHandlers(app.router.stack);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/fail`, { method: "POST" })).status, 500);
  assert.equal((await fetch(`${base}/ok`, { method: "POST" })).status, 204);
});

test("abandoned Motive refresh completes before disconnect clears its token", async t => {
  const express = require("express"), http = require("node:http");
  const oauth = require("../server/services/motiveOAuth"), client = require("../server/services/motiveClient");
  const { registerMotiveOAuthRoutes } = require("../server/routes/motiveOAuthRoutes");
  let unlock, entered, saved = false, cleared = false;
  const barrier = new Promise(resolve => { unlock = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  t.mock.method(oauth, "loadTokens", async () => ({ refresh_token: "synthetic" }));
  t.mock.method(oauth, "refreshAccessToken", async () => { entered(); await barrier; return { access_token: "synthetic" }; });
  t.mock.method(oauth, "saveTokens", async () => { assert.equal(cleared, false); saved = true; });
  t.mock.method(oauth, "clearTokens", async () => { assert.equal(saved, true); cleared = true; });
  t.mock.method(client, "setAccessToken", () => {});
  const app = express(); app.use(createMutationQueue());
  registerMotiveOAuthRoutes(app, { requireSuperAdmin: (req, res, next) => next(), sessionStore: new Map(), getSession: () => null });
  trackMutationHandlers(app.router.stack);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => { unlock(); server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const aborted = http.request(`${base}/api/auth/motive/refresh`, { method: "POST" });
  aborted.on("error", () => {}); aborted.end();
  await started; aborted.destroy();
  const successor = fetch(`${base}/api/auth/motive/disconnect`, { method: "POST" });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(cleared, false);
  unlock();
  assert.equal((await successor).status, 200); assert.equal(cleared, true);
});
