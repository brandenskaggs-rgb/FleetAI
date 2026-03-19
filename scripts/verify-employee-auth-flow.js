const { spawn } = require("child_process");

const BASE_URL = process.env.FLEETAI_TEST_BASE_URL || "http://localhost:3000";
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
    await sleep(400);
  }
  return false;
}

function parseSetCookie(headers) {
  if (!headers || typeof headers.get !== "function") return [];
  const raw = headers.get("set-cookie");
  return raw ? [raw] : [];
}

function extractCookieJar(setCookies) {
  return (setCookies || [])
    .map((item) => String(item || "").split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

async function request(url, { method = "GET", payload, cookie, headers = {}, redirect = "manual" } = {}) {
  const reqHeaders = { ...headers };
  if (payload !== undefined) reqHeaders["Content-Type"] = "application/json";
  if (cookie) reqHeaders.Cookie = cookie;
  const res = await fetch(url, {
    method,
    headers: reqHeaders,
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
    redirect
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {}
  return { res, text, data, setCookies: parseSetCookie(res.headers) };
}

function assert(condition, message, detail) {
  if (!condition) {
    const extra = detail ? ` :: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : "";
    throw new Error(`${message}${extra}`);
  }
}

async function loginAndCapture() {
  const login = await request(`${BASE_URL}/api/auth/employee/login`, {
    method: "POST",
    payload: { email: EMPLOYEE_EMAIL, password: EMPLOYEE_PASSWORD }
  });
  assert(login.res.ok, "Employee login HTTP failure", login.data || login.text);
  assert(login.data.ok !== false, "Employee login app failure", login.data);
  assert(!("token" in (login.data || {})), "Employee login should not return a browser token", login.data);
  assert(login.data.redirect === "/employee-console.html", "Employee login redirect target changed", login.data);
  const cookie = extractCookieJar(login.setCookies);
  assert(cookie.includes("fleetai_session="), "Employee login missing session cookie", login.setCookies);
  return { login, cookie };
}

async function run() {
  if (!EMPLOYEE_EMAIL || !EMPLOYEE_PASSWORD) {
    console.error("Missing employee test credentials. Set FLEETAI_TEST_EMPLOYEE_EMAIL and FLEETAI_TEST_EMPLOYEE_PASSWORD.");
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
    const healthy = await waitForHealth();
    assert(healthy, "Health check failed");

    const first = await loginAndCapture();

    const sessionCheck = await request(`${BASE_URL}/api/employee/session`, { cookie: first.cookie });
    assert(sessionCheck.res.ok, "Employee session probe failed after login", sessionCheck.data);
    assert(sessionCheck.data.employee?.email === EMPLOYEE_EMAIL, "Employee session returned wrong user", sessionCheck.data);

    const consoleLoad = await request(`${BASE_URL}/employee-console.html`, { cookie: first.cookie });
    assert(consoleLoad.res.status === 200, "Employee console should load after login", { status: consoleLoad.res.status });
    assert(consoleLoad.text.includes("Employee Console"), "Employee console HTML did not load", consoleLoad.text.slice(0, 200));

    const refreshCheck = await request(`${BASE_URL}/api/employee/session`, { cookie: first.cookie });
    assert(refreshCheck.res.ok, "Refresh/session persistence check failed", refreshCheck.data);

    const logout = await request(`${BASE_URL}/api/employee/logout`, {
      method: "POST",
      cookie: first.cookie
    });
    assert(logout.res.ok, "Employee logout failed", logout.data);

    const sessionAfterLogout = await request(`${BASE_URL}/api/employee/session`, { cookie: first.cookie });
    assert(sessionAfterLogout.res.status === 401, "Employee session should die after logout", sessionAfterLogout.data);

    const consoleAfterLogout = await request(`${BASE_URL}/employee-console.html`, { cookie: first.cookie });
    assert(consoleAfterLogout.res.status === 302, "Employee console should redirect after logout", { status: consoleAfterLogout.res.status, location: consoleAfterLogout.res.headers.get("location") });
    assert(consoleAfterLogout.res.headers.get("location") === "/employee-login.html", "Employee console redirect target wrong after logout", consoleAfterLogout.res.headers.get("location"));

    const second = await loginAndCapture();
    const secondSession = await request(`${BASE_URL}/api/employee/session`, { cookie: second.cookie });
    assert(secondSession.res.ok, "Second employee login did not establish a new session", secondSession.data);

    console.log("Employee auth flow verification passed.");
    console.log(JSON.stringify({
      loginRedirect: first.login.data.redirect,
      refreshPreservedSession: true,
      logoutRedirect: consoleAfterLogout.res.headers.get("location"),
      secondLoginWorked: true
    }, null, 2));
  } finally {
    if (server) server.kill();
  }
}

run().catch((err) => {
  console.error("Employee auth verification failed:", err.message);
  process.exit(1);
});
