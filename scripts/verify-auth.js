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

function parseSetCookie(headers) {
  if (!headers || typeof headers.get !== "function") return [];
  const direct = headers.get("set-cookie");
  if (!direct) return [];
  return [direct];
}

function extractCookieJar(setCookies) {
  const jar = [];
  for (const item of setCookies || []) {
    const first = String(item || "").split(";")[0].trim();
    if (first) jar.push(first);
  }
  return jar.join("; ");
}

async function requestJson(url, { method = "GET", payload, cookie, headers = {} } = {}) {
  const reqHeaders = { ...headers };
  if (payload !== undefined) reqHeaders["Content-Type"] = "application/json";
  if (cookie) reqHeaders.Cookie = cookie;
  const res = await fetch(url, {
    method,
    headers: reqHeaders,
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
    redirect: "manual"
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {}
  return {
    res,
    data,
    text,
    setCookies: parseSetCookie(res.headers)
  };
}

function assert(condition, message, detail) {
  if (!condition) {
    const extra = detail ? ` :: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : "";
    throw new Error(`${message}${extra}`);
  }
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

  try {
    const ok = await waitForHealth();
    assert(ok, "Health check failed");

    const customerLogin = await requestJson(`${BASE_URL}/api/auth/org/login`, {
      method: "POST",
      payload: { email: CUSTOMER_EMAIL, password: CUSTOMER_PASSWORD }
    });
    assert(customerLogin.res.ok, "Customer login HTTP failure", customerLogin.data);
    assert(customerLogin.data.ok !== false, "Customer login app failure", customerLogin.data);
    assert(customerLogin.data.session?.token, "Customer login missing session token", customerLogin.data);
    const customerCookie = extractCookieJar(customerLogin.setCookies);
    assert(customerCookie, "Customer login missing auth cookie", customerLogin.setCookies);

    const employeeLogin = await requestJson(`${BASE_URL}/api/auth/employee/login`, {
      method: "POST",
      payload: { email: EMPLOYEE_EMAIL, password: EMPLOYEE_PASSWORD }
    });
    assert(employeeLogin.res.ok, "Employee login HTTP failure", employeeLogin.data);
    assert(employeeLogin.data.ok !== false, "Employee login app failure", employeeLogin.data);
    assert(!("token" in employeeLogin.data), "Employee login should not return browser token", employeeLogin.data);
    const employeeCookie = extractCookieJar(employeeLogin.setCookies);
    assert(employeeCookie, "Employee login missing auth cookie", employeeLogin.setCookies);

    const badCustomerLogin = await requestJson(`${BASE_URL}/api/auth/org/login`, {
      method: "POST",
      payload: { email: CUSTOMER_EMAIL, password: `${CUSTOMER_PASSWORD}__bad` }
    });
    assert(badCustomerLogin.res.status === 401, "Bad customer password should be 401", badCustomerLogin.data);
    assert((badCustomerLogin.data.code || badCustomerLogin.data.error) === "INVALID_CREDENTIALS", "Bad customer password wrong error code", badCustomerLogin.data);

    const badEmployeeLogin = await requestJson(`${BASE_URL}/api/auth/employee/login`, {
      method: "POST",
      payload: { email: EMPLOYEE_EMAIL, password: `${EMPLOYEE_PASSWORD}__bad` }
    });
    assert(badEmployeeLogin.res.status === 401, "Bad employee password should be 401", badEmployeeLogin.data);
    assert((badEmployeeLogin.data.code || badEmployeeLogin.data.error) === "INVALID_CREDENTIALS", "Bad employee password wrong error code", badEmployeeLogin.data);

    const unknownCustomer = await requestJson(`${BASE_URL}/api/auth/org/login`, {
      method: "POST",
      payload: { email: "nobody@example.com", password: CUSTOMER_PASSWORD }
    });
    assert(unknownCustomer.res.status === 401, "Unknown customer should be 401", unknownCustomer.data);
    assert((unknownCustomer.data.code || unknownCustomer.data.error) === "USER_NOT_FOUND", "Unknown customer wrong error code", unknownCustomer.data);

    const unknownEmployee = await requestJson(`${BASE_URL}/api/auth/employee/login`, {
      method: "POST",
      payload: { email: "ghost.employee@example.com", password: EMPLOYEE_PASSWORD }
    });
    assert(unknownEmployee.res.status === 401, "Unknown employee should be 401", unknownEmployee.data);
    assert((unknownEmployee.data.code || unknownEmployee.data.error) === "USER_NOT_FOUND", "Unknown employee wrong error code", unknownEmployee.data);

    const customerSession = await requestJson(`${BASE_URL}/api/auth/customer/session`, {
      cookie: customerCookie
    });
    assert(customerSession.res.ok, "Customer session endpoint failed", customerSession.data);
    assert(customerSession.data.user?.email === CUSTOMER_EMAIL, "Customer session returned wrong user", customerSession.data);

    const customerMe = await requestJson(`${BASE_URL}/api/me`, {
      cookie: customerCookie
    });
    assert(customerMe.res.ok, "Customer /api/me failed", customerMe.data);
    assert(customerMe.data.user?.email === CUSTOMER_EMAIL, "Customer /api/me returned wrong user", customerMe.data);

    const employeeSession = await requestJson(`${BASE_URL}/api/employee/session`, {
      cookie: employeeCookie
    });
    assert(employeeSession.res.ok, "Employee session endpoint failed", employeeSession.data);
    assert(employeeSession.data.employee?.email === EMPLOYEE_EMAIL, "Employee session returned wrong user", employeeSession.data);

    const whoamiEmployee = await requestJson(`${BASE_URL}/api/auth/whoami`, {
      cookie: employeeCookie
    });
    assert(whoamiEmployee.res.ok, "Employee whoami failed", whoamiEmployee.data);
    assert(whoamiEmployee.data.type === "employee", "Employee whoami wrong type", whoamiEmployee.data);

    const whoamiCustomer = await requestJson(`${BASE_URL}/api/auth/whoami`, {
      cookie: customerCookie
    });
    assert(whoamiCustomer.res.ok, "Customer whoami failed", whoamiCustomer.data);
    assert(whoamiCustomer.data.type === "customer", "Customer whoami wrong type", whoamiCustomer.data);

    const activeRes = await requestJson(`${BASE_URL}/api/active`);
    assert(activeRes.res.ok, "/api/active failed", { status: activeRes.res.status, body: activeRes.data || activeRes.text });

    const customerLogout = await requestJson(`${BASE_URL}/api/auth/customer/logout`, {
      method: "POST",
      cookie: customerCookie
    });
    assert(customerLogout.res.ok, "Customer logout failed", customerLogout.data);

    const customerSessionAfterLogout = await requestJson(`${BASE_URL}/api/auth/customer/session`, {
      cookie: customerCookie
    });
    assert(customerSessionAfterLogout.res.status === 401, "Customer session should fail after logout", customerSessionAfterLogout.data);

    const employeeLogout = await requestJson(`${BASE_URL}/api/employee/logout`, {
      method: "POST",
      cookie: employeeCookie
    });
    assert(employeeLogout.res.ok, "Employee logout failed", employeeLogout.data);

    const employeeSessionAfterLogout = await requestJson(`${BASE_URL}/api/employee/session`, {
      cookie: employeeCookie
    });
    assert(employeeSessionAfterLogout.res.status === 401, "Employee session should fail after logout", employeeSessionAfterLogout.data);

    console.log("Extended auth verification passed.");
  } finally {
    if (server) server.kill();
  }
}

run().catch((err) => {
  console.error("Verify failed:", err.message);
  process.exit(1);
});
