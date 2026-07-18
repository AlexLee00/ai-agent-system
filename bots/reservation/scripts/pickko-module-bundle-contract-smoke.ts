#!/usr/bin/env node
'use strict';

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { build } = require('esbuild');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const REQUIRED_EXPORTS = [
  'loginToPickko',
  'fetchPickkoEntries',
  'findPickkoMember',
  'submitPickkoSearch',
];

async function main() {
  const probe = await build({
    stdin: {
      contents: [
        "const pickko = require('./bots/reservation/lib/pickko.ts');",
        `const names = ${JSON.stringify(REQUIRED_EXPORTS)};`,
        'const shape = Object.fromEntries(names.map((name) => [name, typeof pickko[name]]));',
        'console.log(JSON.stringify(shape));',
        "if (names.some((name) => typeof pickko[name] !== 'function')) process.exit(1);",
      ].join('\n'),
      resolveDir: PROJECT_ROOT,
      sourcefile: 'pickko-module-bundle-contract-probe.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    target: ['node26'],
    format: 'cjs',
    write: false,
    packages: 'external',
    logLevel: 'silent',
    tsconfig: path.join(PROJECT_ROOT, 'tsconfig.json'),
  });

  const run = spawnSync(process.execPath, ['-e', probe.outputFiles[0].text], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
  });
  assert.strictEqual(run.status, 0, run.stderr || run.stdout || 'bundled Pickko export contract failed');
  const shape = JSON.parse(String(run.stdout || '').trim());
  for (const name of REQUIRED_EXPORTS) {
    assert.strictEqual(shape[name], 'function', `${name} must survive daemon bundling`);
  }
  console.log('pickko-module-bundle-contract-smoke: ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
