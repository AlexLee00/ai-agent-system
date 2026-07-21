// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const skaCheck = require('../lib/checks/ska.ts');
const autofix = require('../lib/autofix.ts');
const runtimePathAudit = require('../../../scripts/audit/ts-runtime-paths.js');

const MINUTE_MS = 60 * 1000;

assert.equal(
  skaCheck._testOnly.classifyAgentStaleness('manual_pickko', 'idle', 25 * MINUTE_MS),
  'ok',
  'an on-demand idle agent must not become stale',
);
assert.equal(
  skaCheck._testOnly.classifyAgentStaleness('manual_pickko', 'idle', 24 * 60 * MINUTE_MS),
  'ok',
);
assert.equal(
  skaCheck._testOnly.classifyAgentStaleness('andy', 'idle', 11 * MINUTE_MS),
  'warn',
  'recurring agents must remain subject to stale detection after an idle cycle',
);
assert.equal(skaCheck._testOnly.classifyAgentStaleness('jimmy', 'idle', 31 * MINUTE_MS), 'error');
assert.equal(skaCheck._testOnly.classifyAgentStaleness('andy', 'running', 11 * MINUTE_MS), 'warn');
assert.equal(skaCheck._testOnly.classifyAgentStaleness('andy', 'running', 31 * MINUTE_MS), 'error');
assert.equal(
  autofix.ALLOWED_AUTOFIX_ACTIONS.has('checksums-update'),
  false,
  'checksum baselines must require the explicit dexter --update-checksums command',
);

const source = [
  "const cjs = require('./actual-cjs');",
  "import esm from './actual-esm';",
  "const dynamic = import('./actual-dynamic');",
  "const fixture = \"require('./fixture-only')\";",
  "const childSource = `const nested = require('./child-only')`;",
  "assert.ok(!text.includes(\"require('./retired-only')\"));",
  "// require('./comment-only')",
].join('\n');

assert.deepEqual(
  runtimePathAudit.collectImportSpecifiers(source, 'fixture.ts'),
  ['./actual-cjs', './actual-esm', './actual-dynamic'],
  'runtime path audit must ignore import-looking text inside strings and templates',
);

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexter-runtime-audit-'));
try {
  const fixturePath = path.join(fixtureDir, 'actual-runtime.ts');
  fs.writeFileSync(fixturePath, "require('./missing-runtime');\nconst fixture = \"require('./ignored')\";\n");
  assert.deepEqual(
    runtimePathAudit.scanFile(fixturePath).map((entry) => entry.specifier),
    ['./missing-runtime'],
    'runtime path audit must still detect an actual broken require',
  );
} finally {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  smoke: 'dexter-system-warning',
  idleAgentStatus: 'ok',
  parsedRuntimeReferences: 3,
  brokenRuntimeReferenceDetected: true,
  checksumAutoUpdateEnabled: false,
}, null, 2));
