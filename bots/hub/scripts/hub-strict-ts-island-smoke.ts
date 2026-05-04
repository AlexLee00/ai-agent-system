#!/usr/bin/env tsx
// @ts-nocheck

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const tsconfigPath = path.join(repoRoot, 'bots/hub/tsconfig.json');
const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'));

assert.equal(tsconfig.compilerOptions?.strict, true, 'bots/hub/tsconfig.json must enable strict mode');
const strictFiles = new Set(tsconfig.files || []);
[
  'lib/llm/l5-contract-types.ts',
  'lib/llm/request-schema.ts',
  'lib/llm/shared-limiter.ts',
  'lib/llm/job-store.ts',
  'src/app.ts',
  'src/middleware/request-context.ts',
  'src/rate-limiters.ts',
  'src/route-registry.ts',
].forEach((file) => {
  assert(strictFiles.has(file), `strict island missing ${file}`);
});
assert((tsconfig.files || []).length >= 9, 'strict island must cover Hub app/route/LLM contracts, not a single file');

const tscBin = path.join(repoRoot, 'node_modules/.bin/tsc');
const result = spawnSync(tscBin, ['-p', tsconfigPath], {
  cwd: repoRoot,
  encoding: 'utf8',
});
if (result.status !== 0) {
  process.stderr.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
}
assert.equal(result.status, 0, 'Hub strict TS island typecheck must pass');

console.log(JSON.stringify({
  ok: true,
  strict: true,
  files: tsconfig.files,
}));
