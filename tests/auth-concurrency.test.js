const assert = require("node:assert/strict");
const db = require("../server/db");
let time = Date.parse("2026-09-01T00:00:00Z");
const users = ["a", "b"].map((id) => ({
  id, email: `${id}@example.test`, passwordHash: `hash-${id}`, role: "ORG_ADMIN",
  kind: "customer", orgId: "org", active: true, isActive: true, updatedAt: new Date(time)
}));
const orgs = [{ id: "org", name: "Original Fleet", status: "ACTIVE", updatedAt: new Date(time) }];
let writes = 0;
function model(rows) {
  return {
    findMany: async () => structuredClone(rows),
    findUnique: async ({ where }) => structuredClone(rows.find((r) => r.id === where.id)),
    updateMany: async ({ where, data }) => {
      const row = rows.find((r) => r.id === where.id && +r.updatedAt === +where.updatedAt);
      if (!row) return { count: 0 };
      Object.assign(row, data, { updatedAt: new Date(++time) });
      writes++;
      return { count: 1 };
    },
    upsert: async () => { throw new Error("Snapshot saves must never bulk-upsert"); }
  };
}
const prisma = { user: model(users), org: model(orgs) };
prisma.$transaction = async (run) => {
  const originalUsers = structuredClone(users), originalOrgs = structuredClone(orgs);
  try { return await run(prisma); } catch (err) {
    users.splice(0, users.length, ...originalUsers);
    orgs.splice(0, orgs.length, ...originalOrgs);
    throw err;
  }
};
db.getPrisma = () => prisma;
const adapter = require("../server/auth/prismaAuthAdapter");
(async () => {
  const login = await adapter.loadData();
  users[1].passwordHash = "new-password-hash";
  users[1].updatedAt = new Date(++time);
  orgs[0].name = "Renamed Fleet";
  orgs[0].updatedAt = new Date(++time);
  login.users[0].lastLoginAt = new Date(++time).toISOString();
  await adapter.saveData(login);
  assert.equal(writes, 1);
  assert.equal(users[1].passwordHash, "new-password-hash");
  assert.equal(orgs[0].name, "Renamed Fleet");
  login.users[0].displayName = "Updated name";
  await adapter.saveData(login);
  assert.equal(users[0].displayName, "Updated name", "sequential saves on the same snapshot work");

  const stale = await adapter.loadData();
  users[0].passwordHash = "reset-while-login-runs";
  users[0].updatedAt = new Date(++time);
  stale.users[0].lastLoginAt = new Date(++time).toISOString();
  await assert.rejects(adapter.saveData(stale), { code: "AUTH_WRITE_CONFLICT" });
  assert.equal(users[0].passwordHash, "reset-while-login-runs");

  const reset1 = await adapter.loadData(), reset2 = await adapter.loadData();
  reset1.users[0].passwordHash = "first-reset";
  reset2.users[0].passwordHash = "replayed-reset";
  await adapter.saveData(reset1);
  await assert.rejects(adapter.saveData(reset2), { code: "AUTH_WRITE_CONFLICT" });
  assert.equal(users[0].passwordHash, "first-reset", "concurrent setup-token reuse cannot replace the first password");
  prisma.user.upsert = async ({ where, create }) => {
    assert.equal(where.id, "new-id", "explicit provisioning must address identity, not overwrite by email");
    if (users.some((row) => row.email === create.email && row.id !== where.id)) {
      const error = new Error("Unique email conflict"); error.code = "P2002"; throw error;
    }
  };
  await assert.rejects(adapter.saveData({ users: [{ id: "new-id", email: users[0].email, passwordHash: "takeover" }], orgs: [] }), { code: "P2002" });
  assert.equal(users[0].passwordHash, "first-reset");
  console.log("Auth concurrency tests passed");
})().catch((err) => { console.error(err); process.exitCode = 1; });
