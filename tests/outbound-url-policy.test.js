const assert = require("assert");
const { isBlockedIp, validateOutboundHttpsUrl } = require("../server/lib/outboundUrlPolicy");

async function run() {
  for (const address of ["127.0.0.1", "10.0.0.1", "172.16.5.4", "192.168.1.1", "169.254.169.254", "::1", "fd00::1"]) {
    assert.strictEqual(isBlockedIp(address), true, address);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
    assert.strictEqual(isBlockedIp(address), false, address);
  }
  await assert.rejects(() => validateOutboundHttpsUrl("http://example.com/hook"), /https_required/);
  await assert.rejects(() => validateOutboundHttpsUrl("https://127.0.0.1/hook"), /private_destination/);
  await assert.rejects(() => validateOutboundHttpsUrl("https://user:pass@example.com/hook"), /credentials/);
  console.log("Outbound URL policy tests: 10 passed, 0 failed");
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
