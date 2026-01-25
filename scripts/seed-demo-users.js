const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const bcrypt = require("bcryptjs");

const DEV_SETUP_MODE = (process.env.DEV_SETUP_MODE || "").toLowerCase() === "true";
if (!DEV_SETUP_MODE) {
  console.error("DEV_SETUP_MODE=true is required to run this script.");
  process.exit(1);
}

const dataPath = path.resolve(__dirname, "..", "server", "data.json");
if (!fs.existsSync(dataPath)) {
  console.error(`Missing data file: ${dataPath}`);
  process.exit(1);
}

const customerEmail = (process.env.DEMO_CUSTOMER_EMAIL || "demo.customer@fleetai.local").toLowerCase();
const customerPassword = process.env.DEMO_CUSTOMER_PASSWORD || "DemoCustomer123!";
const employeeEmail = (process.env.DEMO_EMPLOYEE_EMAIL || "demo.employee@fleetai.local").toLowerCase();
const employeePassword = process.env.DEMO_EMPLOYEE_PASSWORD || "DemoEmployee123!";
const demoOrgId = process.env.DEMO_ORG_ID || "ORG_DEMO";

function writeAtomic(filePath, contents) {
  const tmpPath = `${filePath}.tmp`;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${filePath}.bak-${stamp}`;
  return fsp
    .writeFile(tmpPath, contents, "utf8")
    .then(() => {
      if (fs.existsSync(filePath)) {
        try {
          fs.renameSync(filePath, backupPath);
        } catch (err) {
          fs.copyFileSync(filePath, backupPath);
          fs.unlinkSync(filePath);
        }
      }
      fs.renameSync(tmpPath, filePath);
    });
}

async function run() {
  const raw = await fsp.readFile(dataPath, "utf8");
  let data = {};
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error("Failed to parse data.json:", err.message);
    process.exit(1);
  }
  if (!Array.isArray(data.users)) data.users = [];
  if (!Array.isArray(data.orgs)) data.orgs = [];

  const org = data.orgs.find((o) => o.id === demoOrgId) || {
    id: demoOrgId,
    name: "Demo Org",
    status: "ACTIVE",
    createdAt: new Date().toISOString()
  };
  if (!data.orgs.find((o) => o.id === demoOrgId)) data.orgs.push(org);

  const customerHash = await bcrypt.hash(customerPassword, 12);
  const employeeHash = await bcrypt.hash(employeePassword, 12);

  const customer = data.users.find((u) => String(u.email || "").toLowerCase() === customerEmail);
  if (customer) {
    customer.role = "CUSTOMER";
    customer.orgId = demoOrgId;
    customer.passwordHash = customerHash;
    customer.isActive = true;
    customer.active = true;
  } else {
    data.users.push({
      id: `USR_${Date.now()}_CUST`,
      email: customerEmail,
      role: "CUSTOMER",
      orgId: demoOrgId,
      isActive: true,
      active: true,
      createdAt: new Date().toISOString(),
      passwordHash: customerHash
    });
  }

  const employee = data.users.find((u) => String(u.email || "").toLowerCase() === employeeEmail);
  if (employee) {
    employee.role = "SUPER_ADMIN";
    employee.orgId = demoOrgId;
    employee.passwordHash = employeeHash;
    employee.isActive = true;
    employee.active = true;
  } else {
    data.users.push({
      id: `USR_${Date.now()}_EMP`,
      email: employeeEmail,
      role: "SUPER_ADMIN",
      orgId: demoOrgId,
      isActive: true,
      active: true,
      createdAt: new Date().toISOString(),
      passwordHash: employeeHash
    });
  }

  await writeAtomic(dataPath, JSON.stringify(data, null, 2) + "\n");
  console.log("Demo users seeded:");
  console.log(`- Customer: ${customerEmail}`);
  console.log(`- Employee: ${employeeEmail}`);
}

run().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
