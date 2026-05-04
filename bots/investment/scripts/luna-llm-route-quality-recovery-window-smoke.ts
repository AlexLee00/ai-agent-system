#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import * as db from '../shared/db.ts';
import { recordInvestmentLlmRouteLog } from '../shared/hub-llm-client.ts';
import { buildAgentLlmRouteQualityReport } from '../shared/agent-memory-operational-policy.ts';
import { runAgentMemoryOperator } from './runtime-agent-memory-operator.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function seedSuccessHistory({ agentName, market, incidentKey }) {
  for (let i = 0; i < 10; i += 1) {
    await recordInvestmentLlmRouteLog({
      agentName,
      provider: 'openai-oauth',
      ok: true,
      market,
      taskType: 'final_decision',
      latencyMs: 1200 + i,
      incidentKey,
      routeChain: [{ provider: 'openai-oauth', model: 'gpt-5.4-mini' }],
    });
  }
}

async function seedFailedRoute({ agentName, market, incidentKey }) {
  for (let i = 0; i < 2; i += 1) {
    await recordInvestmentLlmRouteLog({
      agentName,
      provider: 'failed',
      ok: false,
      market,
      taskType: 'final_decision',
      latencyMs: 80 + i,
      incidentKey,
      error: 'fallback_exhausted: provider_cooldown',
      routeChain: [{ provider: 'openai-oauth', model: 'gpt-5.4-mini' }],
    });
  }
}

function hasRouteQualityBlocker(report) {
  return (report.blockers || []).some((item) => String(item).startsWith('route_quality_high_severity'));
}

async function runSmoke() {
  const suffix = Date.now();
  const transientAgent = `route-window-transient-${suffix}`;
  const activeAgent = `route-window-active-${suffix}`;
  const staleAgent = `route-window-stale-${suffix}`;
  const transientMarket = `smoke_p12_transient_${suffix}`;
  const activeMarket = `smoke_p12_active_${suffix}`;
  const staleMarket = `smoke_p12_stale_${suffix}`;
  const transientIncident = `route-window-transient:${suffix}`;
  const activeIncident = `route-window-active:${suffix}`;
  const staleIncident = `route-window-stale:${suffix}`;
  try {
    await seedSuccessHistory({
      agentName: transientAgent,
      market: transientMarket,
      incidentKey: transientIncident,
    });
    await seedFailedRoute({
      agentName: transientAgent,
      market: transientMarket,
      incidentKey: transientIncident,
    });

    const transientQuality = await buildAgentLlmRouteQualityReport({
      days: 1,
      market: transientMarket,
      minCalls: 2,
      recoveryGraceMinutes: 120,
    });
    const transientSuggestion = transientQuality.suggestions.find((item) => item.agent === transientAgent);
    assert.ok(transientSuggestion, 'transient suggestion should be present');
    assert.equal(
      transientSuggestion.type,
      'route_failure_transient_with_success_history',
      'provider with healthy success history should be downgraded to transient observation',
    );
    assert.equal(transientSuggestion.severity, 'medium', 'transient route failures should not be high severity');
    assert.equal(transientQuality.ok, true, 'transient route failure should not fail route quality');

    const transientOperator = await runAgentMemoryOperator({
      days: 1,
      market: transientMarket,
      staleHours: 1,
      dryRun: true,
    });
    assert.equal(hasRouteQualityBlocker(transientOperator), false, 'transient route history should not block operator');
    assert.ok(
      transientOperator.routeQualityObservations.some((item) => item.agent === transientAgent),
      'transient route history should remain observable',
    );

    await seedFailedRoute({
      agentName: activeAgent,
      market: activeMarket,
      incidentKey: activeIncident,
    });
    const activeQuality = await buildAgentLlmRouteQualityReport({
      days: 1,
      market: activeMarket,
      minCalls: 2,
      recoveryGraceMinutes: 120,
    });
    const activeSuggestion = activeQuality.suggestions.find((item) => item.agent === activeAgent);
    assert.ok(activeSuggestion, 'active failure suggestion should be present');
    assert.equal(activeSuggestion.type, 'route_failure_review', 'route without success history needs review');
    assert.equal(activeSuggestion.severity, 'high', 'unrecovered route failure remains high severity');
    assert.equal(activeQuality.ok, false, 'active route failure should fail route quality');

    const activeOperator = await runAgentMemoryOperator({
      days: 1,
      market: activeMarket,
      staleHours: 1,
      dryRun: true,
    });
    assert.equal(hasRouteQualityBlocker(activeOperator), true, 'active route failure should block operator');
    assert.ok(
      activeOperator.routeQualityBlockers.some((item) => item.agent === activeAgent),
      'active route failure should be listed as a route blocker',
    );

    await seedFailedRoute({
      agentName: staleAgent,
      market: staleMarket,
      incidentKey: staleIncident,
    });
    await db.run(
      `UPDATE investment.llm_routing_log
          SET created_at = NOW() - INTERVAL '4 hours'
        WHERE incident_key = $1`,
      [staleIncident],
    );
    const staleQuality = await buildAgentLlmRouteQualityReport({
      days: 1,
      market: staleMarket,
      minCalls: 2,
      recoveryGraceMinutes: 120,
    });
    const staleSuggestion = staleQuality.suggestions.find((item) => item.agent === staleAgent);
    assert.ok(staleSuggestion, 'stale failure suggestion should be present');
    assert.equal(staleSuggestion.type, 'route_failure_stale_observation', 'old failures should downgrade to stale observation');
    assert.equal(staleSuggestion.severity, 'medium', 'stale route failures should not be high severity');
    assert.equal(staleQuality.ok, true, 'stale route failure should not fail route quality');

    const staleOperator = await runAgentMemoryOperator({
      days: 1,
      market: staleMarket,
      staleHours: 1,
      dryRun: true,
    });
    assert.equal(hasRouteQualityBlocker(staleOperator), false, 'stale route failure should not block operator');
    assert.ok(
      staleOperator.routeQualityObservations.some((item) => item.agent === staleAgent),
      'stale route failure should remain observable',
    );

    return {
      ok: true,
      smoke: 'luna-llm-route-quality-recovery-window',
      transientSuggestion,
      activeSuggestion,
      staleSuggestion,
      transientOperatorStatus: transientOperator.status,
      activeOperatorStatus: activeOperator.status,
      staleOperatorStatus: staleOperator.status,
    };
  } finally {
    await db.run(`DELETE FROM investment.llm_routing_log WHERE incident_key = $1`, [transientIncident]).catch(() => null);
    await db.run(`DELETE FROM investment.llm_routing_log WHERE incident_key = $1`, [activeIncident]).catch(() => null);
    await db.run(`DELETE FROM investment.llm_routing_log WHERE incident_key = $1`, [staleIncident]).catch(() => null);
  }
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna-llm-route-quality-recovery-window-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna-llm-route-quality-recovery-window-smoke 실패:',
  });
}
