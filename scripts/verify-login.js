#!/usr/bin/env node
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

async function main() {
  const email = process.env.EMAIL || "customer@fleetai.local";
  const base = process.env.BASE || "http://localhost:3000";
  console.log("Verifying login pipeline for", email, "against", base);
  // Attempt login expecting PASSWORD_SETUP_REQUIRED or OK
  let res = await fetch(`${base}/api/auth/org/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "temp" })
  });
  let data = await res.json();
  console.log("Login attempt 1 status", res.status, data);
  if (data.code !== "PASSWORD_SETUP_REQUIRED" && res.status !== 200) {
    console.error("Expected PASSWORD_SETUP_REQUIRED or 200. Aborting.");
    process.exit(1);
  }
  const newPassword = process.env.NEW_PASSWORD || "FleetAi!123";
  if (data.code === "PASSWORD_SETUP_REQUIRED" && data.setupToken) {
    res = await fetch(`${base}/api/auth/set-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: data.setupToken, newPassword })
    });
    data = await res.json();
    console.log("Set password status", res.status, data);
    if (!res.ok) process.exit(1);
  }
  // Attempt login expecting success
  res = await fetch(`${base}/api/auth/org/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: newPassword })
  });
  data = await res.json();
  console.log("Login attempt 2 status", res.status, data);
  if (!res.ok) process.exit(1);
  console.log("PASS: login flow succeeded");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
