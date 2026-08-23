const assert = require("assert");
const { MALFUNCTION_CODE, DATA_DIAGNOSTIC_CODE } = require("../server/eld/constants");

assert.strictEqual(MALFUNCTION_CODE.ENGINE_SYNC, "E");
assert.strictEqual(MALFUNCTION_CODE.POSITIONING, "L");
assert.strictEqual(DATA_DIAGNOSTIC_CODE.ENGINE_SYNCHRONIZATION, "2");
assert.strictEqual(DATA_DIAGNOSTIC_CODE.UNIDENTIFIED_DRIVING, "5");
assert(!Object.values(DATA_DIAGNOSTIC_CODE).some((code) => /[A-Z]/.test(code)));
console.log("ELD diagnostic code tests: 5 passed, 0 failed");
