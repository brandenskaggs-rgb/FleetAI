const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const {
  loadMaintenanceStores,
  persistMaintenanceChanges,
  upsertLocalOrg,
  upsertLocalUser
} = require("../server/auth/authStoreMaintenance");

const DEV_SETUP_MODE = (process.env.DEV_SETUP_MODE || "").toLowerCase() === "true";
if (!DEV_SETUP_MODE) {
  console.error("DEV_SETUP_MODE=true is required to run this script.");
  process.exit(1);
}

const customerEmail = (process.env.DEMO_CUSTOMER_EMAIL || "demo.customer@fleetai.local").toLowerCase();
const generatedPasswords = {};
function passwordFromEnv(key, email) {
  if (process.env[key]) return process.env[key];
  const generated = crypto.randomBytes(18).toString("base64url");
  generatedPasswords[email] = generated;
  return generated;
}
const employeeEmail = (process.env.DEMO_EMPLOYEE_EMAIL || "demo.employee@fleetai.local").toLowerCase();
const customerPassword = passwordFromEnv("DEMO_CUSTOMER_PASSWORD", customerEmail);
const employeePassword = passwordFromEnv("DEMO_EMPLOYEE_PASSWORD", employeeEmail);
const demoOrgId = process.env.DEMO_ORG_ID || "ORG_DEMO";

async function run() {
  const stores = await loadMaintenanceStores();
  const data = stores.data;
  if (!Array.isArray(data.users)) data.users = [];
  if (!Array.isArray(data.orgs)) data.orgs = [];

  const org = data.orgs.find((o) => o.id === demoOrgId) || {
    id: demoOrgId,
    name: "Demo Org",
    status: "ACTIVE",
    createdAt: new Date().toISOString()
  };
  upsertLocalOrg(data, org);

  const customerHash = await bcrypt.hash(customerPassword, 12);
  const employeeHash = await bcrypt.hash(employeePassword, 12);

  let customer = data.users.find((u) => String(u.email || "").toLowerCase() === customerEmail);
  if (customer) {
    customer.role = "CUSTOMER";
    customer.kind = "customer";
    customer.orgId = demoOrgId;
    customer.passwordHash = customerHash;
    customer.isActive = true;
    customer.active = true;
    customer.verified = true;
  } else {
    customer = {
      id: `USR_${Date.now()}_CUST`,
      email: customerEmail,
      role: "CUSTOMER",
      orgId: demoOrgId,
      isActive: true,
      active: true,
      createdAt: new Date().toISOString(),
      passwordHash: customerHash,
      kind: "customer",
      verified: true
    };
    upsertLocalUser(data, customer);
  }

  let employee = data.users.find((u) => String(u.email || "").toLowerCase() === employeeEmail);
  if (employee) {
    employee.role = "SUPER_ADMIN";
    employee.kind = "employee";
    employee.orgId = null;
    employee.passwordHash = employeeHash;
    employee.isActive = true;
    employee.active = true;
    employee.verified = true;
  } else {
    employee = {
      id: `USR_${Date.now()}_EMP`,
      email: employeeEmail,
      role: "SUPER_ADMIN",
      orgId: null,
      isActive: true,
      active: true,
      createdAt: new Date().toISOString(),
      passwordHash: employeeHash,
      kind: "employee",
      verified: true
    };
    upsertLocalUser(data, employee);
  }

  await persistMaintenanceChanges({ ...stores, data, users: [customer, employee], orgs: [org] });
  console.log("Demo users seeded:");
  console.log(`- Customer: ${customerEmail}`);
  console.log(`- Employee: ${employeeEmail}`);
  Object.entries(generatedPasswords).forEach(([email, password]) => {
    console.warn(`Generated one-time demo password for ${email}: ${password}`);
  });
}

run().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
