const dns = require("dns").promises;
const net = require("net");

function isBlockedIpv4(address) {
  const parts = String(address).split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function isBlockedIp(address) {
  const normalized = String(address || "").trim().toLowerCase().split("%")[0];
  const family = net.isIP(normalized);
  if (family === 4) return isBlockedIpv4(normalized);
  if (family !== 6) return true;
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith("2001:db8:")) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  return mapped ? isBlockedIpv4(mapped[1]) : false;
}

function hostAllowed(hostname, allowedHosts) {
  if (!allowedHosts?.length) return true;
  const host = hostname.toLowerCase();
  return allowedHosts.some((entry) => {
    const allowed = String(entry || "").trim().toLowerCase();
    return allowed && (host === allowed || host.endsWith(`.${allowed}`));
  });
}

async function validateOutboundHttpsUrl(rawUrl, { allowedHosts = [] } = {}) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch (_) {
    throw new Error("invalid_url");
  }
  if (parsed.protocol !== "https:") throw new Error("https_required");
  if (parsed.username || parsed.password) throw new Error("url_credentials_not_allowed");
  if (parsed.port && parsed.port !== "443") throw new Error("nonstandard_port_not_allowed");
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("private_destination_not_allowed");
  }
  if (!hostAllowed(hostname, allowedHosts)) throw new Error("destination_not_allowlisted");

  const literalFamily = net.isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isBlockedIp(address))) {
    throw new Error("private_destination_not_allowed");
  }
  return { parsed, addresses };
}

function pinnedLookup(addresses) {
  let index = 0;
  return (_hostname, options, callback) => {
    const desiredFamily = typeof options === "object" ? Number(options.family || 0) : Number(options || 0);
    const candidates = desiredFamily ? addresses.filter((item) => item.family === desiredFamily) : addresses;
    const selected = candidates[index++ % Math.max(candidates.length, 1)] || addresses[0];
    callback(null, selected.address, selected.family);
  };
}

module.exports = { isBlockedIp, validateOutboundHttpsUrl, pinnedLookup };
