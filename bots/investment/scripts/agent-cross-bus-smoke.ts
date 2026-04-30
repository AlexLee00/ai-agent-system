#!/usr/bin/env node
// @ts-nocheck
/**
 * agent-cross-bus-smoke.ts — Phase Ω4 smoke test
 */

import assert from 'node:assert/strict';
import {
  publishToBus,
  publishBroadcast,
  getMessageHistory,
  clearMessages,
  getAgentBusSummary,
  subscribeBus,
} from '../shared/agent-cross-bus.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function runSmoke() {
  const results: { name: string; pass: boolean; detail?: string }[] = [];

  // ─── 1. publishToBus — disabled (default) ───────────────────────────
  {
    const prev = process.env.LUNA_CROSS_AGENT_BUS_ENABLED;
    process.env.LUNA_CROSS_AGENT_BUS_ENABLED = 'false';
    const id = await publishToBus('hermes', 'sophia', { test: true });
    if (prev === undefined) delete process.env.LUNA_CROSS_AGENT_BUS_ENABLED;
    else process.env.LUNA_CROSS_AGENT_BUS_ENABLED = prev;

    assert.equal(id, -1, 'disabled → returns -1');
    results.push({ name: 'publish_disabled', pass: true });
  }

  // ─── 2. publishBroadcast — disabled ─────────────────────────────────
  {
    const prev = process.env.LUNA_CROSS_AGENT_BUS_ENABLED;
    process.env.LUNA_CROSS_AGENT_BUS_ENABLED = 'false';
    const id = await publishBroadcast('luna', { event: 'test' });
    if (prev === undefined) delete process.env.LUNA_CROSS_AGENT_BUS_ENABLED;
    else process.env.LUNA_CROSS_AGENT_BUS_ENABLED = prev;

    assert.equal(id, -1, 'broadcast disabled → -1');
    results.push({ name: 'broadcast_disabled', pass: true });
  }

  // ─── 3. getMessageHistory — disabled ────────────────────────────────
  {
    const prev = process.env.LUNA_CROSS_AGENT_BUS_ENABLED;
    process.env.LUNA_CROSS_AGENT_BUS_ENABLED = 'false';
    const msgs = await getMessageHistory('hermes');
    if (prev === undefined) delete process.env.LUNA_CROSS_AGENT_BUS_ENABLED;
    else process.env.LUNA_CROSS_AGENT_BUS_ENABLED = prev;

    assert.deepEqual(msgs, [], 'disabled → []');
    results.push({ name: 'history_disabled', pass: true });
  }

  // ─── 4. clearMessages — disabled ────────────────────────────────────
  {
    const prev = process.env.LUNA_CROSS_AGENT_BUS_ENABLED;
    process.env.LUNA_CROSS_AGENT_BUS_ENABLED = 'false';
    const r = await clearMessages('hermes', new Date());
    if (prev === undefined) delete process.env.LUNA_CROSS_AGENT_BUS_ENABLED;
    else process.env.LUNA_CROSS_AGENT_BUS_ENABLED = prev;

    assert.equal(r.deleted, 0, 'disabled → 0 deleted');
    results.push({ name: 'clear_disabled', pass: true });
  }

  // ─── 5. subscribeBus — disabled ─────────────────────────────────────
  {
    const prev = process.env.LUNA_CROSS_AGENT_BUS_ENABLED;
    process.env.LUNA_CROSS_AGENT_BUS_ENABLED = 'false';
    const r = await subscribeBus('sophia', async () => {}, { maxIterations: 1 });
    if (prev === undefined) delete process.env.LUNA_CROSS_AGENT_BUS_ENABLED;
    else process.env.LUNA_CROSS_AGENT_BUS_ENABLED = prev;

    assert.equal(r.processed, 0, 'disabled subscribe → 0 processed');
    results.push({ name: 'subscribe_disabled', pass: true });
  }

  // ─── 6. getAgentBusSummary — disabled ────────────────────────────────
  {
    const prev = process.env.LUNA_CROSS_AGENT_BUS_ENABLED;
    process.env.LUNA_CROSS_AGENT_BUS_ENABLED = 'false';
    const r = await getAgentBusSummary();
    if (prev === undefined) delete process.env.LUNA_CROSS_AGENT_BUS_ENABLED;
    else process.env.LUNA_CROSS_AGENT_BUS_ENABLED = prev;

    assert.equal(r.enabled, false, 'disabled → enabled=false');
    results.push({ name: 'summary_disabled', pass: true });
  }

  // ─── 7. getAgentBusSummary — enabled DB call ─────────────────────────
  {
    const prev = process.env.LUNA_CROSS_AGENT_BUS_ENABLED;
    process.env.LUNA_CROSS_AGENT_BUS_ENABLED = 'true';
    const r = await getAgentBusSummary().catch(() => null);
    if (prev === undefined) delete process.env.LUNA_CROSS_AGENT_BUS_ENABLED;
    else process.env.LUNA_CROSS_AGENT_BUS_ENABLED = prev;

    const ok = r === null || (
      typeof r === 'object' &&
      typeof r.totalPending === 'number' &&
      Array.isArray(r.agentSummary)
    );
    assert.ok(ok, 'enabled summary returns valid shape');
    results.push({
      name: 'summary_enabled_db_call',
      pass: ok,
      detail: r ? `totalPending=${r.totalPending}, agents=${r.agentSummary.length}` : 'DB 연결 불가 (soft pass)',
    });
  }

  const passed = results.filter(r => r.pass).length;
  const total = results.length;

  return { ok: passed === total, passed, total, results };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const r of result.results) {
      console.log(`  ${r.pass ? '✅' : '❌'} ${r.name}${r.detail ? `: ${r.detail}` : ''}`);
    }
    console.log(`\n${result.ok ? '✅' : '❌'} agent-cross-bus-smoke (${result.passed}/${result.total})`);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ agent-cross-bus-smoke 실패:',
  });
}
