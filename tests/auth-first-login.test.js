const assert = require("assert");
const bcrypt = require("bcryptjs");
const { createAuthService } = require("../server/auth/authService");

(async () => {
  const temporaryPassword = "Temporary-Access-123";
  const user = {
    id: "USR_TEST",
    email: "owner@example.test",
    role: "ORG_ADMIN",
    kind: "customer",
    orgId: "ORG_TEST",
    isActive: true,
    passwordHash: await bcrypt.hash(temporaryPassword, 4),
    mustSetPassword: true,
    requirePasswordReset: true,
    isTemporaryPassword: true
  };
  const data = { users: [user], orgs: [{ id: "ORG_TEST", name: "Test Fleet" }] };
  let saves = 0;
  const service = createAuthService({
    loadData: async () => data,
    saveData: async () => { saves += 1; },
    issueSession: () => ({ id: "SESSION_TEST" }),
    devSetupMode: false
  });

  const rejected = await service.authenticate("customer", user.email, "wrong-password");
  assert.strictEqual(rejected.error.code, "INVALID_CREDENTIALS");
  assert.strictEqual(user.setupTokenHash, undefined, "wrong password must not issue a setup token");
  assert.strictEqual(saves, 0);

  const accepted = await service.authenticate("customer", user.email, temporaryPassword);
  assert.strictEqual(accepted.error.code, "PASSWORD_SETUP_REQUIRED");
  assert.ok(accepted.next.token);
  assert.ok(user.setupTokenHash);
  assert.strictEqual(saves, 1);

  console.log("First-login authentication tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
