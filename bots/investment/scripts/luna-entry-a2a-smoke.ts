#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { handleTask } from '../a2a/handlers/task-handler.ts';
import { createEntryDecisionShadowHandler, registerEntryDecisionShadowSkill } from '../a2a/skills/entry-decision-shadow.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function fakeQuery(sql) {
  if (sql.includes('luna_entry_llm_shadow')) {
    return [{
      trigger_id: 'trigger-BTC/USDT',
      symbol: 'BTC/USDT',
      exchange: 'binance',
      market: 'crypto',
      trigger_type: 'breakout_confirmation',
      deterministic_fire: true,
      deterministic_reason: 'breakout_retest_mtf_confirmed',
      deterministic_confidence: 0.74,
      rule_regime: 'trending_bull',
      llm_regime: 'trending_bull',
      llm_fire: true,
      llm_confidence: 0.76,
      dynamic_threshold: 0.68,
      position_size_pct: 0.12,
      reasoning: 'smoke shadow entry valid',
      risk_assessment: { risk_level: 'medium' },
      n_agent_debate: {
        finalVote: { fire: true, confidence: 0.72, reason: 'smoke_consensus' },
      },
      context_evidence: {
        analysis: { signalCounts: { BUY: 1 } },
        risk: { sameSymbolOpen: 0 },
      },
      match: true,
      observed_at: '2026-05-11T00:00:00.000Z',
    }];
  }
  return [];
}

export async function runLunaEntryA2ASmoke() {
  registerEntryDecisionShadowSkill({ queryFn: fakeQuery });

  const result = await handleTask({
    id: 'entry-a2a-smoke-1',
    skill: { id: 'entry-decision-shadow' },
    params: { symbol: 'BTC/USDT', exchange: 'binance' },
  });
  assert.equal(result.id, 'entry-a2a-smoke-1');
  assert.equal(result.status, 'completed');
  assert.equal(result.output.ok, true);
  assert.equal(result.output.skill, 'entry-decision-shadow');
  assert.equal(result.output.dataHealth, 'shadow_ready');
  assert.equal(result.output.deterministic.fire, true);
  assert.equal(result.output.llm.fire, true);
  assert.equal(result.output.match, true);
  assert.equal(result.output.contextEvidence.analysis.signalCounts.BUY, 1);
  assert.equal(result.output.broadcastPlanned, false);

  const alias = await handleTask({
    id: 'entry-a2a-smoke-2',
    skill: { id: 'trade-signal-generation' },
    params: { symbol: 'BTC/USDT', exchange: 'binance' },
  });
  assert.equal(alias.status, 'completed');
  assert.equal(alias.output.skill, 'trade-signal-generation');
  assert.equal(alias.output.shadowMode, true);

  const debate = await handleTask({
    id: 'entry-a2a-smoke-3',
    skill: { id: 'n-agent-debate' },
    params: { symbol: 'BTC/USDT', exchange: 'binance' },
  });
  assert.equal(debate.status, 'completed');
  assert.equal(debate.output.skill, 'n-agent-debate');
  assert.equal(debate.output.debate.finalVote.fire, true);

  const previous = process.env.LUNA_A2A_BROADCAST_ENABLED;
  process.env.LUNA_A2A_BROADCAST_ENABLED = 'true';
  const enabled = await createEntryDecisionShadowHandler({ queryFn: fakeQuery })({
    symbol: 'BTC/USDT',
    exchange: 'binance',
  });
  assert.equal(enabled.output.broadcastPlanned, true);
  if (previous == null) delete process.env.LUNA_A2A_BROADCAST_ENABLED;
  else process.env.LUNA_A2A_BROADCAST_ENABLED = previous;

  const candidateOnly = await createEntryDecisionShadowHandler({ queryFn: () => [] })({
    symbol: 'ETH/USDT',
    exchange: 'binance',
    confidence: 0.72,
    triggerHints: {
      mtfAgreement: 0.8,
      mtfDominantSignal: 'BUY',
      discoveryScore: 0.7,
      volumeBurst: 1.8,
      breakoutRetest: true,
    },
  });
  assert.equal(candidateOnly.status, 'completed');
  assert.equal(candidateOnly.output.dataHealth, 'candidate_only');
  assert.equal(candidateOnly.output.llm, null);
  assert.equal(candidateOnly.output.debate.agents.zeusBull.stance, 'support');

  let triggerOnlySql = '';
  let triggerOnlyParams = [];
  const triggerOnly = await createEntryDecisionShadowHandler({
    queryFn: (sql, params) => {
      triggerOnlySql = sql;
      triggerOnlyParams = params;
      return [{
        trigger_id: 'kis-overseas-trigger',
        symbol: 'NVDA',
        exchange: 'kis_overseas',
        market: 'overseas',
        deterministic_fire: true,
        deterministic_reason: 'mtf_discovery_confirmed',
        deterministic_confidence: 0.73,
        llm_fire: true,
        llm_confidence: 0.75,
        dynamic_threshold: 0.7,
        position_size_pct: 0.08,
        risk_assessment: {},
        n_agent_debate: {},
        context_evidence: {},
        match: true,
        observed_at: '2026-05-11T00:00:00.000Z',
      }];
    },
  })({ triggerId: 'kis-overseas-trigger' });
  assert.equal(triggerOnly.status, 'completed');
  assert.equal(triggerOnly.output.exchange, 'kis_overseas');
  assert.equal(triggerOnlyParams.length, 1);
  assert.equal(/exchange\s*=/.test(triggerOnlySql), false);

  return {
    ok: true,
    smoke: 'luna-entry-a2a-phase2',
    skill: result.output.skill,
    alias: alias.output.skill,
    debate: debate.output.skill,
    broadcastDefault: result.output.broadcastPlanned,
    broadcastEnabled: enabled.output.broadcastPlanned,
  };
}

async function main() {
  const result = await runLunaEntryA2ASmoke();
  console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna entry A2A smoke 실패:',
  });
}
