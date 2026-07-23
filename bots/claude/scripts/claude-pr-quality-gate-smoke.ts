#!/usr/bin/env node
'use strict';

const assert = require('assert');

async function main() {
  const skills = await import('../a2a/skills/index' + '.ts');
  const pass = (await skills.runQualityGate({
    builder: { pass: true },
    reviewer: { pass: true },
    guardian: { pass: true },
    tests: { pass: true, total: 10, failed: 0 },
  })).output;
  assert.strictEqual(pass.pass, true);
  assert.strictEqual(pass.totalScore, 100);
  assert.strictEqual(pass.verdict, 'approve_candidate');

  const protectedGate = (await skills.runQualityGate({
    builder: { pass: true },
    reviewer: { pass: true },
    guardian: { pass: true },
    tests: { pass: true },
    changedFiles: ['bots/investment/scripts/runtime-luna-live-test.ts'],
  })).output;
  assert.strictEqual(protectedGate.pass, false);
  assert.strictEqual(protectedGate.verdict, 'blocked_protected');

  const regression = (await skills.runQualityGate({
    builder: { pass: true },
    reviewer: { pass: true },
    guardian: { pass: true },
    tests: { pass: false, total: 10, failed: 3, regression: true },
  })).output;
  assert.strictEqual(regression.pass, false);
  assert.ok(regression.scores.reviewer < 35);

  console.log(JSON.stringify({ ok: true, checked: ['approve_candidate', 'blocked_protected', 'regression_penalty'] }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
