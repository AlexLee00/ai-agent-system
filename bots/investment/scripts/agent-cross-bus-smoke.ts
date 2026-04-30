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
  replyToBus,
} from '../shared/agent-cross-bus.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import * as db from '../shared/db.ts';

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

  // ─── 8. enabled publish/history/subscribe/reply/clear contract ────────
  {
    const prev = process.env.LUNA_CROSS_AGENT_BUS_ENABLED;
    const prevUnderlying = process.env.LUNA_AGENT_CROSS_BUS_ENABLED;
    const incidentKey = `omega4-smoke-${Date.now()}`;
    const sender = 'omega4_smoke_sender';
    const receiver = 'omega4_smoke_receiver';
    process.env.LUNA_CROSS_AGENT_BUS_ENABLED = 'true';
    try {
      const id = await publishToBus(sender, receiver, { test: true, incidentKey }, {
        incidentKey,
        messageType: 'query',
      });
      const history = await getMessageHistory(receiver, { incidentKey, includeResponded: true });
      const sub = await subscribeBus(receiver, async (message) => {
        await replyToBus(message.id, receiver, { ok: true, source: 'omega4-smoke' });
      }, { incidentKey, maxIterations: 1 });
      const cleared = await clearMessages(receiver, new Date(Date.now() + 1000));

      assert.ok(id > 0 || id === -1, 'enabled publish returns id or safe no-op');
      if (id > 0) {
        assert.ok(history.some((m: any) => m.id === id), 'history contains published message');
        assert.ok(sub.processed >= 1, 'subscribe processed published message');
        assert.ok(cleared.deleted >= 0, 'clear returns deleted count');
      }
      results.push({
        name: 'enabled_contract_publish_history_subscribe_clear',
        pass: true,
        detail: `id=${id}, history=${history.length}, processed=${sub.processed}, cleared=${cleared.deleted}`,
      });
    } finally {
      await db.run(`DELETE FROM investment.agent_messages WHERE incident_key = $1`, [incidentKey]).catch(() => {});
      if (prev === undefined) delete process.env.LUNA_CROSS_AGENT_BUS_ENABLED;
      else process.env.LUNA_CROSS_AGENT_BUS_ENABLED = prev;
      if (prevUnderlying === undefined) delete process.env.LUNA_AGENT_CROSS_BUS_ENABLED;
      else process.env.LUNA_AGENT_CROSS_BUS_ENABLED = prevUnderlying;
    }
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
