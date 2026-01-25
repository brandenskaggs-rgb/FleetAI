const { spawn } = require("child_process");

const BASE_URL = process.env.FLEETAI_TEST_BASE_URL || "http://localhost:3000";
const CUSTOMER_EMAIL = process.env.FLEETAI_TEST_CUSTOMER_EMAIL || "";
const CUSTOMER_PASSWORD = process.env.FLEETAI_TEST_CUSTOMER_PASSWORD || "";
const EMPLOYEE_EMAIL = process.env.FLEETAI_TEST_EMPLOYEE_EMAIL || "";
const EMPLOYEE_PASSWORD = process.env.FLEETAI_TEST_EMPLOYEE_PASSWORD || "";
const SKIP_START = process.env.FLEETAI_TEST_SKIP_START === "1";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return true;
    } catch (_) {}
    await sleep(500);
  }
  return false;
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {}
  return { res, data };
}

async function run() {
  if (!CUSTOMER_EMAIL || !CUSTOMER_PASSWORD || !EMPLOYEE_EMAIL || !EMPLOYEE_PASSWORD) {
    console.error("Missing test credentials. Set:");
    console.error("  FLEETAI_TEST_CUSTOMER_EMAIL / FLEETAI_TEST_CUSTOMER_PASSWORD");
    console.error("  FLEETAI_TEST_EMPLOYEE_EMAIL / FLEETAI_TEST_EMPLOYEE_PASSWORD");
    process.exit(1);
  }

  let server = null;
  if (!SKIP_START) {
    server = spawn("node", ["server.js"], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: "inherit"
    });
  }

  const ok = await waitForHealth();
  if (!ok) {
    console.error("Health check failed.");
    if (server) server.kill();
    process.exit(1);
  }

  const cust = await postJson(`${BASE_URL}/api/auth/org/login`, {
    email: CUSTOMER_EMAIL,
    password: CUSTOMER_PASSWORD
  });
  if (!cust.res.ok || cust.data.ok === false || !cust.data.session?.token) {
    console.error("Customer login failed:", cust.data);
    if (server) server.kill();
    process.exit(1);
  }

  const emp = await postJson(`${BASE_URL}/api/auth/employee/login`, {
    email: EMPLOYEE_EMAIL,
    password: EMPLOYEE_PASSWORD
  });
  if (!emp.res.ok || emp.data.ok === false || !emp.data.token) {
    console.error("Employee login failed:", emp.data);
    if (server) server.kill();
    process.exit(1);
  }

  const activeRes = await fetch(`${BASE_URL}/api/active`);
  if (!activeRes.ok) {
    console.error("/api/active failed:", activeRes.status);
    if (server) server.kill();
    process.exit(1);
  }

  console.log("Auth verification passed.");
  if (server) server.kill();
}

run().catch((err) => {
  console.error("Verify failed:", err.message);
  process.exit(1);
});
