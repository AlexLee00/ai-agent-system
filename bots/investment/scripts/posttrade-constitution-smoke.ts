#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  loadLunaConstitution,
  evaluateLunaConstitutionForEntry,
  evaluateLunaConstitutionForTrade,
} from '../shared/luna-constitution.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function runSmoke() {
  const constitution = loadLunaConstitution();
  assert.equal(constitution.ok, true, 'luna constitution file exists');
  assert.ok(constitution.ruleCount >= 8, 'constitution has executable rule lines');

  const lowConfidence = evaluateLunaConstitutionForEntry({
    action: 'BUY',
    market: 'crypto',
    confidence: 0.42,
  });
  assert.equal(lowConfidence.blocked, true, 'low confidence entry blocked');
  assert.ok(lowConfidence.violations.some((item) => item.code === 'confidence_below_constitution_minimum'));

  const nemesis = evaluateLunaConstitutionForEntry({
    action: 'BUY',
    market: 'crypto',
    confidence: 0.72,
    nemesisRiskLevel: 'CRITICAL',
  });
  assert.equal(nemesis.blocked, true, 'nemesis critical veto blocks');

  const tradeAudit = evaluateLunaConstitutionForTrade({
    trade: { pnl_percent: -3.5 },
    reviewData: { constitution_violations: 1 },
    backtestData: { constitution_violations: [{ code: 'backtest_rule_miss' }] },
  });
  assert.equal(tradeAudit.ok, false, 'trade violation audit detects violations');
  assert.ok(tradeAudit.violationCount >= 3, 'legacy + trade + backtest violations counted');

  return {
    ok: true,
    ruleCount: constitution.ruleCount,
    lowConfidence: lowConfidence.violations.map((item) => item.code),
    nemesis: nemesis.violations.map((item) => item.code),
    tradeViolationCount: tradeAudit.violationCount,
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('posttrade-constitution-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ posttrade-constitution-smoke 실패:',
  });
}

