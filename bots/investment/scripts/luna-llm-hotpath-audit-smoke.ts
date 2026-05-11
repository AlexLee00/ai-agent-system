#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildLlmHotPathAudit,
  classifyPipelineLlmHotPath,
  extractCollectPlan,
} from './runtime-luna-llm-hotpath-audit.ts';

function fixtureSession(meta, extra = {}) {
  return {
    session_id: extra.sessionId || 'session-smoke',
    market: extra.market || 'kis',
    trigger_type: extra.triggerType || 'cycle',
    status: extra.status || 'completed',
    started_at: 1778217795380,
    meta,
  };
}

export async function runLunaLlmHotPathAuditSmoke() {
  const stockLight = fixtureSession({
    collect_mode: 'intraday_monitoring_light',
    collect_agent_plan: {
      source: 'runtime_agent_plan',
      nodeIds: ['L06', 'L02', 'L04'],
    },
  });
  assert.deepEqual(extractCollectPlan(stockLight.meta).nodeIds, ['L06', 'L02', 'L04']);
  assert.equal(classifyPipelineLlmHotPath(stockLight).ok, true);

  const stockRegress = fixtureSession({
    collect_mode: 'intraday_monitoring_light',
    collect_agent_plan: {
      source: 'default_market_plan',
      nodeIds: ['L06', 'L02', 'L03', 'L04'],
    },
  });
  const stockRegressResult = classifyPipelineLlmHotPath(stockRegress);
  assert.equal(stockRegressResult.ok, false);
  assert.ok(stockRegressResult.reasons.includes('stock_light_path_includes_sentiment_node_L03'));

  const cryptoLight = fixtureSession({
    collect_mode: 'intraday_monitoring_light',
    collect_agent_plan: {
      source: 'runtime_agent_plan',
      nodeIds: ['L06', 'L02'],
    },
  }, { market: 'binance' });
  assert.equal(classifyPipelineLlmHotPath(cryptoLight).ok, true);

  const cryptoRegress = fixtureSession({
    collect_mode: 'active_candidate_analysis_refresh',
    collect_agent_plan: {
      source: 'default_market_plan',
      nodeIds: ['L06', 'L02', 'L03', 'L05'],
    },
  }, { market: 'binance', triggerType: 'active_candidate_analysis_refresh' });
  const cryptoRegressResult = classifyPipelineLlmHotPath(cryptoRegress);
  assert.equal(cryptoRegressResult.ok, false);
  assert.ok(cryptoRegressResult.reasons.includes('crypto_light_path_includes_sentiment_node_L03'));
  assert.ok(cryptoRegressResult.reasons.includes('crypto_light_path_includes_onchain_node_L05'));

  const targetedOk = fixtureSession({
    collect_mode: 'active_candidate_targeted_enrichment',
    targeted_enrichment: true,
    agentPlan: {
      collect: { nodeIds: ['L03', 'L05'] },
    },
    llm_call_policy: {
      source_enrichment: 'targeted_top_n_only',
      targeted_enrichment_max_symbols: 1,
      targeted_enrichment_cooldown_minutes: 120,
    },
  }, { market: 'binance', triggerType: 'active_candidate_targeted_enrichment' });
  const targetedOkResult = classifyPipelineLlmHotPath(targetedOk);
  assert.equal(targetedOkResult.ok, true);
  assert.equal(targetedOkResult.targetedEnrichment, true);

  const targetedTooBroad = fixtureSession({
    collect_mode: 'active_candidate_targeted_enrichment',
    targeted_enrichment: true,
    agentPlan: {
      collect: { nodeIds: ['L03', 'L05'] },
    },
    llm_call_policy: {
      source_enrichment: 'targeted_top_n_only',
      targeted_enrichment_max_symbols: 3,
      targeted_enrichment_cooldown_minutes: 45,
    },
  }, { market: 'binance', triggerType: 'active_candidate_targeted_enrichment' });
  const targetedTooBroadResult = classifyPipelineLlmHotPath(targetedTooBroad);
  assert.equal(targetedTooBroadResult.ok, false);
  assert.ok(targetedTooBroadResult.reasons.includes('targeted_enrichment_symbol_cap_too_high'));
  assert.ok(targetedTooBroadResult.reasons.includes('targeted_enrichment_cooldown_too_short'));

  const historicalTargeted = fixtureSession({
    collect_mode: 'relaxed_probe_l13_collect',
    targeted_enrichment: true,
    market_script: 'luna_relaxed_probe_runner',
    agentPlan: {
      collect: { nodeIds: ['L06', 'L02', 'L03', 'L05'] },
    },
    llm_call_policy: {
      source_enrichment: 'targeted_top_n_only',
    },
  }, {
    market: 'binance',
    triggerType: 'relaxed_probe_l13',
    sessionId: 'historical-relaxed-probe',
  });
  const historicalAudit = buildLlmHotPathAudit({
    pipelineSessions: [historicalTargeted],
    sourceMitigationCutoffs: { relaxed_probe_l13: 1778217795381 },
    generatedAt: '2026-05-08T00:00:00.000Z',
  });
  assert.equal(historicalAudit.ok, true);
  assert.equal(historicalAudit.status, 'luna_llm_hotpath_clear_with_historical_mitigated_sessions');
  assert.equal(historicalAudit.totals.suspiciousSessions, 0);
  assert.equal(historicalAudit.totals.historicalMitigatedSessions, 1);
  assert.ok(historicalAudit.nonBlockingWarnings.includes('historical_llm_hotpath_sessions_before_current_source'));

  const auditClear = buildLlmHotPathAudit({
    topCalls: [{ agent_name: 'luna', calls: 2, failed_calls: 0 }],
    pipelineSessions: [stockLight, cryptoLight, targetedOk],
    staleActiveRefreshRunning: [],
    generatedAt: '2026-05-08T00:00:00.000Z',
  });
  assert.equal(auditClear.ok, true);
  assert.equal(auditClear.status, 'luna_llm_hotpath_clear');

  const auditAttention = buildLlmHotPathAudit({
    topCalls: [{ agent_name: 'hermes', calls: 15, failed_calls: 0 }],
    pipelineSessions: [stockRegress, cryptoRegress, targetedTooBroad],
    staleActiveRefreshRunning: [fixtureSession({}, { triggerType: 'active_candidate_analysis_refresh' })],
    generatedAt: '2026-05-08T00:00:00.000Z',
  });
  assert.equal(auditAttention.ok, false);
  assert.equal(auditAttention.totals.suspiciousSessions, 3);
  assert.equal(auditAttention.totals.staleActiveRefreshRunning, 1);
  assert.ok(auditAttention.warnings.includes('unexpected_llm_enrichment_path_detected'));
  assert.ok(auditAttention.nonBlockingWarnings.includes('stale_active_candidate_refresh_sessions_detected'));

  const staleOnly = buildLlmHotPathAudit({
    topCalls: [],
    pipelineSessions: [stockLight],
    staleActiveRefreshRunning: [fixtureSession({}, { triggerType: 'active_candidate_analysis_refresh' })],
    generatedAt: '2026-05-08T00:00:00.000Z',
  });
  assert.equal(staleOnly.ok, true);
  assert.equal(staleOnly.status, 'luna_llm_hotpath_clear_with_historical_stale_sessions');

  return {
    ok: true,
    smoke: 'luna-llm-hotpath-audit',
    suspiciousFixtureCount: auditAttention.totals.suspiciousSessions,
  };
}

async function main() {
  const result = await runLunaLlmHotPathAuditSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna-llm-hotpath-audit-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna-llm-hotpath-audit-smoke 실패:',
  });
}
