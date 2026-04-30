#!/usr/bin/env node
// @ts-nocheck
/**
 * luna-discovery-mature-policy-smoke.ts — Phase Ω2 smoke test
 */

import assert from 'node:assert/strict';
import {
  classifyMatureSignal,
  filterMatureFromNewEntries,
  classifyAllActiveMatureSignals,
} from '../shared/luna-discovery-mature-policy.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function runSmoke() {
  const results: { name: string; pass: boolean }[] = [];

  // ─── 1. classifyMatureSignal — immature (보유일 부족) ───────────────
  {
    const r = classifyMatureSignal({ daysHeld: 2 });
    assert.equal(r.classification, 'immature', '2일 보유 → immature');
    results.push({ name: 'classify_immature_by_days', pass: true });
  }

  // ─── 2. classifyMatureSignal — immature (validity 낮음) ─────────────
  {
    const r = classifyMatureSignal({ daysHeld: 10, validityScore: 0.5 });
    assert.equal(r.classification, 'immature', 'validity=0.5 → immature');
    results.push({ name: 'classify_immature_by_validity', pass: true });
  }

  // ─── 3. classifyMatureSignal — immature (drift 과다) ─────────────
  {
    const r = classifyMatureSignal({ daysHeld: 10, validityScore: 0.8, pnlDrift24h: 0.1 });
    assert.equal(r.classification, 'immature', 'drift=10% → immature');
    results.push({ name: 'classify_immature_by_drift', pass: true });
  }

  // ─── 4. classifyMatureSignal — mature ───────────────────────────────
  {
    const r = classifyMatureSignal({ daysHeld: 10, validityScore: 0.8, pnlDrift24h: 0.01 });
    assert.equal(r.classification, 'mature', '10일, validity=0.8, drift=1% → mature');
    assert.ok(r.reason.length > 0, 'reason 존재');
    results.push({ name: 'classify_mature', pass: true });
  }

  // ─── 5. filterMatureFromNewEntries — disabled (default) ─────────────
  {
    const prev = process.env.LUNA_DISCOVERY_MATURE_POLICY_ENABLED;
    process.env.LUNA_DISCOVERY_MATURE_POLICY_ENABLED = 'false';
    const r = await filterMatureFromNewEntries(['BTCUSDT', 'ETHUSDT']);
    if (prev === undefined) delete process.env.LUNA_DISCOVERY_MATURE_POLICY_ENABLED;
    else process.env.LUNA_DISCOVERY_MATURE_POLICY_ENABLED = prev;

    assert.deepEqual(r.allowed, ['BTCUSDT', 'ETHUSDT'], 'disabled → 모두 허용');
    assert.equal(r.held.length, 0, 'disabled → held 없음');
    results.push({ name: 'filter_disabled_passthrough', pass: true });
  }

  // ─── 6. classifyAllActiveMatureSignals — disabled ──────────────────
  {
    const prev = process.env.LUNA_DISCOVERY_MATURE_POLICY_ENABLED;
    process.env.LUNA_DISCOVERY_MATURE_POLICY_ENABLED = 'false';
    const r = await classifyAllActiveMatureSignals();
    if (prev === undefined) delete process.env.LUNA_DISCOVERY_MATURE_POLICY_ENABLED;
    else process.env.LUNA_DISCOVERY_MATURE_POLICY_ENABLED = prev;

    assert.equal(r.enabled, false, 'disabled → enabled=false');
    assert.equal(r.checked, 0, 'disabled → checked=0');
    results.push({ name: 'classify_all_disabled', pass: true });
  }

  // ─── 7. classifyAllActiveMatureSignals — enabled DB call ───────────
  {
    const prev = process.env.LUNA_DISCOVERY_MATURE_POLICY_ENABLED;
    process.env.LUNA_DISCOVERY_MATURE_POLICY_ENABLED = 'true';
    const r = await classifyAllActiveMatureSignals({ limit: 10 }).catch(() => null);
    if (prev === undefined) delete process.env.LUNA_DISCOVERY_MATURE_POLICY_ENABLED;
    else process.env.LUNA_DISCOVERY_MATURE_POLICY_ENABLED = prev;

    // DB 연결 불가 시 null → soft pass
    const enabled = r?.enabled ?? false;
    results.push({
      name: 'classify_all_enabled_db_call',
      pass: r === null || (typeof r === 'object' && typeof r.checked === 'number'),
    });
    if (r !== null) {
      assert.ok(typeof r.matureCount === 'number', 'matureCount is number');
      assert.ok(typeof r.immatureCount === 'number', 'immatureCount is number');
      assert.ok(Array.isArray(r.positions), 'positions is array');
    }
  }

  const passed = results.filter(r => r.pass).length;
  const total = results.length;

  return {
    ok: passed === total,
    passed,
    total,
    results,
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const r of result.results) {
      console.log(`  ${r.pass ? '✅' : '❌'} ${r.name}`);
    }
    console.log(`\n${result.ok ? '✅' : '❌'} luna-discovery-mature-policy-smoke (${result.passed}/${result.total})`);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna-discovery-mature-policy-smoke 실패:',
  });
}
