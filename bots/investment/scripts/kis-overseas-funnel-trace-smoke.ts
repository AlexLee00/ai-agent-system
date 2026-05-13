#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { buildFunnelClassification } from './runtime-kis-overseas-funnel-trace.ts';

function runSmoke() {
  const report = {
    bottlenecks: ['active_candidates_filtered_before_signal'],
    likelyActionableCount: 0,
    entryCapacity: { openCount: 1, maxOpenPositions: 2, remainingSlots: 1 },
    top: [
      {
        symbol: 'AAPL',
        actionability: 'filtered_before_signal',
        recommendation: 'wait_for_technical_and_flow_confirmation',
        reasons: ['fusion_not_long', 'technical_not_confirmed', 'market_flow_not_confirmed', 'news_only_buy'],
        fused: { recommendation: 'HOLD', fusedScore: 0.07, averageConfidence: 0.38 },
        analystSummary: {
          byAnalyst: {
            news: { signal: 'BUY', confidence: 0.8, reasoning: 'positive catalyst' },
            market_flow: { signal: 'HOLD', confidence: 0.12, reasoning: 'flow not confirmed' },
            ta_mtf: { signal: 'HOLD', confidence: 0.42, reasoning: 'trend not confirmed' },
          },
        },
      },
      {
        symbol: 'MSFT',
        actionability: 'filtered_before_signal',
        recommendation: 'wait_for_trend_confirmation',
        reasons: ['fusion_not_long', 'technical_not_confirmed', 'market_flow_not_confirmed'],
        fused: { recommendation: 'HOLD', fusedScore: 0, averageConfidence: 0.34 },
        analystSummary: {
          byAnalyst: {
            sentiment: { signal: 'HOLD', confidence: 0.1, reasoning: 'Hub LLM 호출 실패: The operation was aborted due to timeout' },
          },
        },
      },
    ],
  };
  const classification = buildFunnelClassification({
    decisionReport: report,
    signalRows: [],
    openPositions: [],
    llmRows: [{ success: false, error: 'timeout' }],
    realUsdViewExists: false,
    queryErrors: [{ label: 'agent_events', error: 'relation does not exist' }],
  });
  assert.equal(classification.status, 'kis_overseas_funnel_attention');
  assert.ok(classification.attention.includes('active_candidates_filtered_before_signal'));
  assert.ok(classification.attention.includes('no_likely_actionable_overseas_candidate'));
  assert.ok(classification.attention.includes('llm_timeout_or_abort_seen'));
  assert.ok(classification.attention.includes('missing_investment_v_trades_real_usd_view'));
  assert.ok(classification.attention.includes('supporting_query_failed'));
  assert.equal(classification.primaryCauseCounts.news_buy_without_market_flow_confirmation, 1);
  assert.equal(classification.primaryCauseCounts.llm_timeout_evidence_in_analysis, 1);
  return { ok: true, status: 'kis_overseas_funnel_trace_smoke_passed', classification };
}

const result = runSmoke();
if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
else console.log(result.status);
