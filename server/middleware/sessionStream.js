"use strict";

// SSE authentication is not a one-time check: cookies may be revoked while a
// connection remains open. Serialize authorization and bound queued payloads.
function protectSessionStream(req, res) {
  if (typeof req.revalidateSession !== "function") return;
  const write = res.write.bind(res);
  let closed = false;
  let queued = 0;
  let tail = Promise.resolve();
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    res.end();
  };
  const check = async () => {
    try { return !closed && await req.revalidateSession(); }
    catch (_) { return false; }
  };
  res.write = (chunk, encoding, callback) => {
    if (closed) return false;
    if (++queued > 32) { close(); return false; }
    tail = tail.then(async () => {
      if (await check()) write(chunk, encoding, callback);
      else close();
    }).catch(close).finally(() => { queued--; });
    return true;
  };
  const timer = setInterval(() => { check().then(valid => { if (!valid) close(); }); }, 15000);
  timer.unref?.();
  const cleanup = () => { closed = true; clearInterval(timer); };
  req.once("close", cleanup);
  res.once("close", cleanup);
}

module.exports = { protectSessionStream };
