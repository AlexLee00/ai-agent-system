#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import * as db from '../shared/db.ts';
import { recordInvestmentLlmRouteLog } from '../shared/hub-llm-client.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function runSmoke() {
  await db.initSchema();
  const agentName = `route-smoke-${Date.now()}`;
  const incidentKey = `route-smoke:${Date.now()}`;
  try {
    await recordInvestmentLlmRouteLog({
      agentName,
      provider: 'gemini-oauth',
      ok: true,
      costUsd: 0.0001,
      latencyMs: 1234,
      market: 'crypto',
      symbol: 'BTC/USDT',
      taskType: 'final_decision',
      incidentKey,
      routeChain: [{ provider: 'gemini-oauth', model: 'gemini-2.5-flash' }],
    });
    await recordInvestmentLlmRouteLog({
      agentName,
      provider: 'direct_fallback',
      ok: true,
      market: 'crypto',
      taskType: 'final_decision',
      incidentKey,
      fallbackUsed: true,
      fallbackCount: 1,
      error: 'hub_failed',
    });

    const rows = await db.query(
      `SELECT agent_name, provider, response_ok, fallback_used, route_chain, error
         FROM investment.llm_routing_log
        WHERE agent_name = $1 AND incident_key = $2
        ORDER BY created_at ASC`,
      [agentName, incidentKey],
    );
    assert.equal(rows.length, 2, 'two route log rows persisted');
    assert.equal(rows[0].response_ok, true, 'success response_ok persisted');
    assert.equal(rows[1].fallback_used, true, 'fallback_used persisted');
    assert.ok(Array.isArray(rows[0].route_chain) || typeof rows[0].route_chain === 'object', 'route_chain persisted as json');

    return { ok: true, rows: rows.length, fallbackProvider: rows[1].provider };
  } finally {
    await db.run(`DELETE FROM investment.llm_routing_log WHERE agent_name = $1 AND incident_key = $2`, [agentName, incidentKey]).catch(() => null);
  }
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('agent-llm-route-log-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ agent-llm-route-log-smoke 실패:',
  });
}
