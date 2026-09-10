const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { createStorage } = require("../server/lib/storage");
const { createDataStore } = require("../server/storage/dataStore");

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
    const firstReader = await storage.loadData(), secondReader = await storage.loadData();
    firstReader.users.push({ id: "first-company-owner" });
    await storage.saveData(Object.assign({}, firstReader));
    secondReader.users.push({ id: "second-company-owner" });
    await assert.rejects(storage.saveData(Object.assign({}, secondReader)), { code: "DATA_WRITE_CONFLICT" });
    assert.deepStrictEqual((await storage.loadData()).users, [{ id: "first-company-owner" }]);
    const damagedFile = path.join(dir, "damaged.json");
    const damaged = '{"users":[{"id":"important-account"';
    await fs.writeFile(damagedFile, damaged);
    const brokenStore = createStorage({ dataPath: damagedFile, defaultData: { users: [], orgs: [] } });
    await assert.rejects(brokenStore.loadData(), { code: "DATA_STORE_CORRUPT" });
    assert.strictEqual(await fs.readFile(damagedFile, "utf8"), damaged);
    await assert.rejects(brokenStore.loadData(), { code: "DATA_STORE_CORRUPT" });
    assert.strictEqual(brokenStore.getStatus().status, "CORRUPT");
    assert.strictEqual((await fs.readdir(dir)).filter(name => name.startsWith('damaged.json.bad-')).length, 1);

    for (const [index, contents] of ['[]', 'null', '{"users":{}}', '{"orgs":"lost"}'].entries()) {
      const invalidFile = path.join(dir, `invalid-${index}.json`);
      await fs.writeFile(invalidFile, contents);
      const invalid = createStorage({ dataPath: invalidFile, defaultData: { users: [], orgs: [] } });
      await assert.rejects(invalid.loadData(), { code: 'DATA_STORE_CORRUPT' });
      assert.strictEqual(await fs.readFile(invalidFile, 'utf8'), contents);
      await assert.rejects(invalid.saveData({ users: {} }), /must be an array/);
    }

    const recoveryFile = path.join(dir, 'recovery.json');
    await fs.writeFile(recoveryFile, '{broken');
    await fs.writeFile(`${recoveryFile}.bak-2026-01-01`, JSON.stringify({ users: [{ id: 'retained' }], orgs: [] }));
    await fs.writeFile(`${recoveryFile}.bak-2026-02-01`, '[]');
    const recovery = createStorage({ dataPath: recoveryFile, defaultData: { users: [], orgs: [] } });
    const restored = await recovery.loadData();
    assert.strictEqual(restored.users[0].id, 'retained');
    assert.strictEqual(recovery.getStatus().status, 'RECOVERED');
    const newer = await recovery.loadData();
    newer.users.push({ id: 'new-owner' });
    await recovery.saveData(newer);
    restored.users.push({ id: 'stale-owner' });
    await assert.rejects(recovery.saveData(restored), { code: 'DATA_WRITE_CONFLICT' });

    const initialFile = path.join(dir, 'initial.json');
    const initial = createStorage({ dataPath: initialFile, defaultData: { users: [], orgs: [] } });
    const readers = await Promise.all(Array.from({ length: 20 }, () => initial.loadData()));
    readers[0].users.push({ id: 'first' });
    await initial.saveData(readers[0]);
    await assert.rejects(initial.saveData(readers[1]), { code: 'DATA_WRITE_CONFLICT' });
    assert.strictEqual((await initial.loadData()).users[0].id, 'first');
    const wrapped = createDataStore({ dataPath: initialFile, defaultData: { users: [], orgs: [] } });
    await assert.rejects(wrapped.safeWriteData({ users: { accidental: 'map' } }), /must be an array/);
    assert.strictEqual((await wrapped.loadData()).users[0].id, 'first');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  console.log("Storage atomicity and fail-closed recovery tests passed");
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
