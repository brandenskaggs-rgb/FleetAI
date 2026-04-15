const express = require("express");
const crypto = require("crypto");

const CODE_CHARS = "0123456789";
const CODE_LENGTH = 6;
const PIN_LENGTH = 6;
const EXPIRE_MINUTES = 1440;

function nowIso() {
  return new Date().toISOString();
}

function generateCode() {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return out;
}

function generatePin() {
  let out = "";
  for (let i = 0; i < PIN_LENGTH; i += 1) {
    out += Math.floor(Math.random() * 10).toString();
  }
  return out;
}

function isExpired(expiresAt) {
  if (!expiresAt) return true;
  return new Date(expiresAt).getTime() <= Date.now();
}

function createPairing({ vehicleId, driverId }) {
  const expiresAt = new Date(Date.now() + EXPIRE_MINUTES * 60000).toISOString();
  return {
    id: `PAIR_${crypto.randomBytes(6).toString("hex")}`,
    vehicleId,
    driverId,
    pairCode: generateCode(),
    pairingCode: generateCode(),
    driverPin: generatePin(),
    createdAt: nowIso(),
    expiresAt,
    pinExpiresAt: expiresAt,
    status: "active"
  };
}

function findActivePairings(pairings, vehicleId, driverId) {
  return (pairings || []).filter((p) => {
    if (p.status !== "active") return false;
    if (isExpired(p.expiresAt) || isExpired(p.pinExpiresAt)) return false;
    return p.vehicleId === vehicleId || p.driverId === driverId;
  });
}

function expirePairing(pairing) {
  pairing.status = "expired";
  pairing.expiresAt = nowIso();
  pairing.pinExpiresAt = pairing.expiresAt;
  pairing.expiredAt = pairing.expiresAt;
}

function createPairingRouter({ storage, requireAuth, log }) {
  const router = express.Router();
  const logger = log || console.log;

  router.get("/health", (req, res) => {
    res.json({ ok: true, time: nowIso(), version: "pairing-v2" });
  });

  router.get("/active", requireAuth, async (req, res) => {
    const data = await storage.loadData();
    const pairings = data.pairings || [];
    let mutated = false;
    pairings.forEach((p) => {
      if (p.status === "active" && (isExpired(p.expiresAt) || isExpired(p.pinExpiresAt))) {
        expirePairing(p);
        mutated = true;
      }
    });
    if (mutated) await storage.saveData(data);
    const active = pairings.filter((p) => p.status === "active" && !isExpired(p.expiresAt));
    res.json({ ok: true, pairings: active });
  });

  router.get("/status", requireAuth, async (req, res) => {
    const data = await storage.loadData();
    const pairings = data.pairings || [];
    let mutated = false;
    pairings.forEach((p) => {
      if (p.status === "active" && (isExpired(p.expiresAt) || isExpired(p.pinExpiresAt))) {
        expirePairing(p);
        mutated = true;
      }
    });
    if (mutated) await storage.saveData(data);
    const active = pairings.filter((p) => p.status === "active" && !isExpired(p.expiresAt));
    res.json({ ok: true, pairings: active });
  });

  router.post("/generate", requireAuth, async (req, res) => {
    const { vehicleId, driverId, replaceActive } = req.body || {};
    if (!vehicleId || !driverId) {
      return res.status(400).json({ ok: false, error: "MISSING_FIELDS", message: "vehicleId and driverId required" });
    }
    const data = await storage.loadData();
    const vehicle = (data.vehicles || []).find((v) => v.vehicleId === vehicleId);
    const driver = (data.drivers || []).find((d) => d.driverId === driverId);
    if (!vehicle || !driver) {
      return res.status(404).json({ ok: false, error: "NOT_FOUND", message: "Vehicle or driver not found" });
    }
    const activeMatches = findActivePairings(data.pairings || [], vehicleId, driverId);
    if (activeMatches.length && !replaceActive) {
      const active = activeMatches[0];
      logger("[PAIRING] conflict", { vehicleId, driverId, pairingId: active.id });
      return res.status(409).json({
        ok: false,
        error: "ACTIVE_PAIRING",
        activePairing: active
      });
    }
    if (activeMatches.length) {
      activeMatches.forEach(expirePairing);
    }
    const pairing = createPairing({ vehicleId, driverId });
    data.pairings = data.pairings || [];
    data.pairings.unshift(pairing);
    await storage.saveData(data);
    logger("[PAIRING] generated", { vehicleId, driverId, pairingId: pairing.id });
    res.json({
      ok: true,
      conflict: false,
      replacedAssignmentId: activeMatches[0]?.id || null,
      assignmentId: pairing.id,
      pairCode: pairing.pairCode,
      expiresAt: pairing.expiresAt,
      driverPin: pairing.driverPin,
      pinExpiresAt: pairing.pinExpiresAt,
      pairing
    });
  });

  router.post("/expire", requireAuth, async (req, res) => {
    const { pairingId, vehicleId, driverId } = req.body || {};
    if (!pairingId && !vehicleId && !driverId) {
      return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });
    }
    const data = await storage.loadData();
    let expired = 0;
    (data.pairings || []).forEach((p) => {
      const match = (pairingId && p.id === pairingId)
        || (!pairingId && vehicleId && p.vehicleId === vehicleId)
        || (!pairingId && driverId && p.driverId === driverId);
      if (match && p.status === "active") {
        expirePairing(p);
        expired += 1;
      }
    });
    await storage.saveData(data);
    res.json({ ok: true, expired });
  });

  return router;
}

module.exports = { createPairingRouter };
