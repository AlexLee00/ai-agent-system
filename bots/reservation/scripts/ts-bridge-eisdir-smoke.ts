#!/usr/bin/env tsx

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runTsCliBridge } = require('../manual/reservation/ts-cli-bridge.js');
const { loadTsSourceBridge } = require('../lib/ts-source-bridge.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reservation-ts-bridge-eisdir-'));

try {
  const cliJs = path.join(tmpRoot, 'cli.js');
  const cliTsDir = path.join(tmpRoot, 'cli.ts');
  fs.writeFileSync(cliJs, '#!/usr/bin/env node\n', 'utf8');
  fs.mkdirSync(cliTsDir);

  assert.throws(
    () => runTsCliBridge(cliJs),
    /TS source path is not a regular file/,
    'CLI bridge should reject a directory before readFileSync can raise EISDIR',
  );

  const sourceDir = path.join(tmpRoot, 'source');
  fs.mkdirSync(sourceDir);
  fs.mkdirSync(path.join(sourceDir, 'module.ts'));

  assert.throws(
    () => loadTsSourceBridge(sourceDir, 'module'),
    /TS source path is not a regular file/,
    'Source bridge should reject a directory before readFileSync can raise EISDIR',
  );

  console.log('ts_bridge_eisdir_smoke_ok');
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
