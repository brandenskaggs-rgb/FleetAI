#!/usr/bin/env node
/**
 * Fleet AI Partner Provisioning Script
 *
 * Creates a partner_ml API key for a marketplace partner (e.g. Motive).
 * The raw key is displayed ONCE — copy it and send it to the partner.
 *
 * Usage (interactive):
 *   node scripts/provision-partner.js
 *
 * Usage (CLI flags):
 *   node scripts/provision-partner.js --partner "Motive" --tier partner_ml --orgId org_motive
 *
 * Revoke a key by ID:
 *   node scripts/provision-partner.js --revoke <key-id>
 *
 * List all keys:
 *   node scripts/provision-partner.js --list
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const readline = require("readline");
const crypto   = require("crypto");
const { PrismaClient } = require("@prisma/client");

const VALID_TIERS = ["standard", "partner_ml", "enterprise"];

function generateApiKey(prefix = "fai") {
  const raw  = `${prefix}_${crypto.randomBytes(24).toString("hex")}`;
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

function box(lines) {
  const width = Math.max(...lines.map(l => l.length)) + 4;
  const hr = "─".repeat(width);
  console.log(`\n  ┌${hr}┐`);
  for (const line of lines) {
    const pad = " ".repeat(width - line.length - 2);
    console.log(`  │  ${line}${pad}  │`);
  }
  console.log(`  └${hr}┘\n`);
}

async function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

async function createKey(prisma, { partner, tier, orgId }) {
  const { raw, hash } = generateApiKey("fai");
  const record = await prisma.apiKey.create({
    data: { keyHash: hash, partnerName: partner, orgId: orgId || null, tier, enabled: true },
  });

  console.log(`\n  ✓  API key created`);
  box([
    `Partner : ${record.partnerName}`,
    `Key ID  : ${record.id}`,
    `Tier    : ${record.tier}`,
    `Org ID  : ${record.orgId || "(none)"}`,
    `Created : ${record.createdAt.toISOString()}`,
    ``,
    `API KEY — copy now, not stored in plaintext:`,
    ``,
    `  ${raw}`,
  ]);
  console.log("  Send this key to the partner in a secure channel.");
  console.log("  It cannot be recovered. If lost, revoke and create a new one.\n");
  console.log(`  To revoke later:`);
  console.log(`    node scripts/provision-partner.js --revoke ${record.id}\n`);
}

async function revokeKey(prisma, id) {
  const key = await prisma.apiKey.findUnique({ where: { id } });
  if (!key) {
    console.error(`\n  ✗  No API key found with ID: ${id}\n`);
    process.exit(1);
  }
  await prisma.apiKey.update({ where: { id }, data: { enabled: false } });
  console.log(`\n  ✓  API key revoked`);
  box([
    `Partner : ${key.partnerName}`,
    `Key ID  : ${key.id}`,
    `Status  : REVOKED`,
  ]);
}

async function listKeys(prisma) {
  const keys = await prisma.apiKey.findMany({ orderBy: { createdAt: "desc" } });
  if (!keys.length) {
    console.log("\n  No API keys found.\n");
    return;
  }
  console.log(`\n  Fleet AI Partner API Keys (${keys.length} total)\n`);
  console.log(`  ${"ID".padEnd(30)} ${"Partner".padEnd(22)} ${"Tier".padEnd(14)} ${"Status".padEnd(10)} Last Used`);
  console.log(`  ${"─".repeat(30)} ${"─".repeat(22)} ${"─".repeat(14)} ${"─".repeat(10)} ${"─".repeat(24)}`);
  for (const k of keys) {
    const status   = k.enabled ? "active" : "REVOKED";
    const lastUsed = k.lastUsedAt ? k.lastUsedAt.toISOString().slice(0, 19) : "never";
    console.log(`  ${k.id.padEnd(30)} ${k.partnerName.slice(0,21).padEnd(22)} ${k.tier.padEnd(14)} ${status.padEnd(10)} ${lastUsed}`);
  }
  console.log();
}

async function main() {
  const args = process.argv.slice(2);

  // Parse flags
  let partner = null, tier = "partner_ml", orgId = null;
  let revokeId = null, doList = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--partner"  && args[i+1]) partner  = args[++i];
    if (args[i] === "--tier"     && args[i+1]) tier     = args[++i];
    if (args[i] === "--orgId"    && args[i+1]) orgId    = args[++i];
    if (args[i] === "--revoke"   && args[i+1]) revokeId = args[++i];
    if (args[i] === "--list")    doList = true;
  }

  const prisma = new PrismaClient();
  try {
    await prisma.$connect();

    if (doList) {
      await listKeys(prisma);
      return;
    }

    if (revokeId) {
      await revokeKey(prisma, revokeId);
      return;
    }

    // Create mode — prompt if args not supplied
    if (!partner) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      console.log("\n  Fleet AI — Partner API Key Provisioner\n");

      partner = ((await ask(rl, "  Partner name (e.g. Motive):            ")) || "").trim();
      if (!partner) { console.error("\n  Partner name is required.\n"); process.exit(1); }

      const tierIn = ((await ask(rl, "  Tier [partner_ml]:                     ")) || "").trim();
      if (tierIn) tier = tierIn;

      const orgIn = ((await ask(rl, "  Org ID (optional, press enter to skip): ")) || "").trim();
      if (orgIn) orgId = orgIn;

      rl.close();
    }

    if (!VALID_TIERS.includes(tier)) {
      console.error(`\n  Invalid tier "${tier}". Valid options: ${VALID_TIERS.join(", ")}\n`);
      process.exit(1);
    }

    await createKey(prisma, { partner, tier, orgId });

  } catch (err) {
    console.error("\n  Error:", err.message, "\n");
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
