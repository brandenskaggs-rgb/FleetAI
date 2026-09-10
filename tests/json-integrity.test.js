const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0').filter(file => file.endsWith('.json'));
const invalid = [];
for (const file of files) {
  try { JSON.parse(fs.readFileSync(path.join(root, file), 'utf8').replace(/^\uFEFF/, '')); }
  catch (_) { invalid.push(file); }
}
assert.deepEqual(invalid, [], 'Tracked JSON must parse without NaN/Infinity or silent repair');
console.log(`Strict JSON validation passed for ${files.length} tracked files`);
