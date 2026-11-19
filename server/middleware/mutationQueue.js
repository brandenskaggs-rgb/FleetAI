"use strict";

// Legacy JSON writes need ordering across the entire request. A cancelled waiter
// must retain its place until its predecessor completes, without taking the lock.
function createMutationQueue({ telemetryJsonMirrorEnabled = true } = {}) {
  let tail = Promise.resolve();
  const middleware = async function mutationQueue(req, res, next) {
    const path = String(req.path || req.url || "").split("?")[0];
    const databaseTelemetry = !telemetryJsonMirrorEnabled &&
      ["/api/telemetry", "/api/telemetry/snapshot", "/api/telemetry/ingest"].includes(path);
    if (databaseTelemetry || req._fleetAiMutationLockHeld ||
        !["POST", "PUT", "PATCH", "DELETE"].includes(String(req.method || "").toUpperCase())) return next();
    const previous = tail;
    let release;
    const completed = new Promise(resolve => { release = resolve; });
    tail = previous.catch(() => {}).then(() => completed);
    let ended = false;
    const state = { pending: 0, releaseIfComplete: () => {
      if (ended && state.pending === 0) release();
    } };
    const finish = () => {
      if (ended) return;
      ended = true;
      res.removeListener("finish", finish);
      res.removeListener("close", finish);
      state.releaseIfComplete();
    };
    res.once("finish", finish);
    res.once("close", finish);
    if (res.destroyed || res.writableEnded) finish();
    await previous.catch(() => {});
    if (ended || res.destroyed || res.writableEnded) { finish(); return; }
    req._fleetAiMutationLockHeld = true;
    req._fleetAiMutationState = state;
    try { return next(); }
    catch (error) { finish(); return next(error); }
  };
  middleware._fleetAiQueueMiddleware = true;
  return middleware;
}

// Express does not await next(). Track the promises returned by registered leaf
// handlers so a disconnected response cannot unlock a still-running mutation.
// Install after route registration, before accepting traffic. Router/route
// containers are traversed rather than wrapped; error-handler arity is retained.
function trackMutationHandlers(stack) {
  if (!Array.isArray(stack)) throw new Error("mutation_handler_stack_unavailable");
  for (const layer of stack) {
    if (layer.route?.stack) { trackMutationHandlers(layer.route.stack); continue; }
    if (layer.handle?.stack) { trackMutationHandlers(layer.handle.stack); continue; }
    const original = layer.handle;
    if (typeof original !== "function" || original._fleetAiQueueMiddleware || original._fleetAiTracked) continue;
    function invoke(receiver, req, args, next) {
      const state = req._fleetAiMutationState;
      if (!state) return original.apply(receiver, args);
      state.pending++;
      const complete = () => { state.pending--; state.releaseIfComplete(); };
      try {
        const result = original.apply(receiver, args);
        if (result && typeof result.then === "function") {
          return Promise.resolve(result).then(
            value => { complete(); return value; },
            error => { try { next(error || new Error("Rejected promise")); } finally { complete(); } }
          );
        }
        complete();
        return result;
      } catch (error) {
        try { return next(error); } finally { complete(); }
      }
    }
    layer.handle = original.length === 4
      ? function trackedError(error, req, res, next) { return invoke(this, req, [error, req, res, next], next); }
      : function trackedRequest(req, res, next) { return invoke(this, req, [req, res, next], next); };
    layer.handle._fleetAiTracked = true;
  }
}

module.exports = { createMutationQueue, trackMutationHandlers };
