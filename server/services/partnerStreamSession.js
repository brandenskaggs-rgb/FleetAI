// A bounded authorization lease stops revoked keys and stalled database checks
// from leaving a live data stream open indefinitely.
function createPartnerStreamSession({ req, res, identity, authorize, onClose,
  recheckMs = 25_000, leaseMs = 35_000, maxAgeMs = 15 * 60_000 }) {
  let closed = false;
  let checking = false;
  let validUntil = Date.now() + leaseMs;
  let heartbeat;
  let expiry;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(expiry);
    req.off("aborted", close);
    res.off("close", close);
    onClose();
    res.end();
  };
  const write = (data) => {
    if (closed || Date.now() >= validUntil || res.destroyed || res.writableEnded) {
      close();
      return;
    }
    try { if (!res.write(data)) close(); } catch (_) { close(); }
  };
  const refresh = async () => {
    if (closed || checking) return;
    checking = true;
    let timeout;
    try {
      const active = await Promise.race([
        authorize(identity),
        new Promise((resolve) => { timeout = setTimeout(() => resolve(null), Math.max(1, validUntil - Date.now())); })
      ]);
      if (closed) return;
      if (!active || Date.now() >= validUntil) return close();
      validUntil = Date.now() + leaseMs;
      write(": heartbeat\n\n");
    } catch (_) { close(); }
    finally { clearTimeout(timeout); checking = false; }
  };
  heartbeat = setInterval(refresh, recheckMs);
  expiry = setTimeout(close, maxAgeMs);
  heartbeat.unref?.();
  expiry.unref?.();
  req.on("aborted", close);
  res.on("close", close);
  return { write, close };
}

module.exports = { createPartnerStreamSession };
