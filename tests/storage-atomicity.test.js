const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { createStorage } = require("../server/lib/storage");

async function run() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fleetai-storage-"));
  const file = path.join(dir, "data.json");
  try {
    const storage = createStorage({ dataPath: file, defaultData: { users: [], orgs: [], value: 0 } });
    await storage.saveData({ users: [], orgs: [], value: 1 });
    await Promise.all(Array.from({ length: 20 }, (_, index) => storage.saveData({ users: [], orgs: [], value: index + 2 })));
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    assert.strictEqual(parsed.value, 21);
    const names = await fs.readdir(dir);
    assert(!names.some((name) => name.endsWith(".tmp")));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  console.log("Storage atomicity tests: 2 passed, 0 failed");
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
