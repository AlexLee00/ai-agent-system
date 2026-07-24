#!/usr/bin/env node
'use strict';

const assert = require('assert');

async function main() {
  // @ts-expect-error tsx loads this .ts source directly; remove when this tsconfig enables allowImportingTsExtensions.
  const skills = await import('../a2a/skills/index.ts');
  const pass = (await skills.runQualityGate({
    builder: { pass: true },
    reviewer: { pass: true },
    guardian: { pass: true },
    tests: { pass: true, total: 10, failed: 0 },
  })).output;
  if (!pass || typeof pass !== 'object' || Array.isArray(pass)) throw new TypeError('passing quality gate output must be an object');
  assert.strictEqual(Reflect.get(pass, 'pass'), true);
  assert.strictEqual(Reflect.get(pass, 'totalScore'), 100);
  assert.strictEqual(Reflect.get(pass, 'verdict'), 'approve_candidate');

  const protectedGate = (await skills.runQualityGate({
    builder: { pass: true },
    reviewer: { pass: true },
    guardian: { pass: true },
    tests: { pass: true },
    changedFiles: ['bots/investment/scripts/runtime-luna-live-test.ts'],
  })).output;
  if (!protectedGate || typeof protectedGate !== 'object' || Array.isArray(protectedGate)) throw new TypeError('protected quality gate output must be an object');
  assert.strictEqual(Reflect.get(protectedGate, 'pass'), false);
  assert.strictEqual(Reflect.get(protectedGate, 'verdict'), 'blocked_protected');

  const regression = (await skills.runQualityGate({
    builder: { pass: true },
    reviewer: { pass: true },
    guardian: { pass: true },
    tests: { pass: false, total: 10, failed: 3, regression: true },
  })).output;
  if (!regression || typeof regression !== 'object' || Array.isArray(regression)) throw new TypeError('regression quality gate output must be an object');
  assert.strictEqual(Reflect.get(regression, 'pass'), false);
  const regressionScores = Reflect.get(regression, 'scores');
  if (!regressionScores || typeof regressionScores !== 'object' || Array.isArray(regressionScores)) throw new TypeError('regression quality gate scores must be an object');
  const reviewerScore = Reflect.get(regressionScores, 'reviewer');
  if (typeof reviewerScore !== 'number') throw new TypeError('regression reviewer score must be a number');
  assert.ok(reviewerScore < 35);

  console.log(JSON.stringify({ ok: true, checked: ['approve_candidate', 'blocked_protected', 'regression_penalty'] }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
