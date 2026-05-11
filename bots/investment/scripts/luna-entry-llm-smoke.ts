#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildEntryDecisionDebate,
  normalizeEntryLlmShadowResult,
} from '../shared/entry-llm-shadow-judge.ts';
import { runLunaEntryLlmShadow } from './runtime-luna-entry-llm-shadow.ts';

const FAKE_SK_VALUE = ['sk', 'test', 'secret', '1234567890'].join('-');
const FAKE_BEARER_VALUE = ['abcdefghijkl', 'mnop'].join('');

function fixtureTrigger(symbol = 'BTC/USDT') {
  return {
    id: `trigger-${symbol}`,
    symbol,
    exchange: 'binance',
    setup_type: 'breakout',
    trigger_type: 'breakout_confirmation',
    trigger_state: 'armed',
    confidence: 0.74,
    predictive_score: 0.66,
    trigger_context: {
      hints: {
        mtfAgreement: 0.82,
        mtfAlignmentScore: 0.3,
        mtfDominantSignal: 'BUY',
        discoveryScore: 0.7,
        volumeBurst: 1.9,
        breakoutRetest: true,
      },
    },
    trigger_meta: {},
  };
}

function fakeDeps({ existingShadow = false } = {}) {
  const inserts = [];
  const llmCalls = [];
  const listCalls = [];
  return {
    inserts,
    llmCalls,
    listCalls,
    initSchema: async () => ({ ok: true }),
    listActiveEntryTriggers: async (args) => {
      listCalls.push(args);
      return args.exchange === 'binance' ? [fixtureTrigger()] : [];
    },
    query: async (sql) => {
      if (sql.includes('luna_entry_llm_shadow') && existingShadow) {
        return [{
          trigger_id: 'trigger-BTC/USDT',
          symbol: 'BTC/USDT',
          exchange: 'binance',
          observed_at: new Date().toISOString(),
        }];
      }
      if (sql.includes('luna_regime_llm_shadow')) {
        return [{
          market: 'crypto',
          rule_regime: 'trending_bull',
          llm_regime: 'trending_bull',
          llm_confidence: 0.82,
          match: true,
          captured_at: new Date().toISOString(),
        }];
      }
      if (sql.includes('FROM investment.analysis')) {
        return [
          {
            analyst: 'ta_mtf',
            signal: 'BUY',
            confidence: 0.74,
            reasoning: `mtf bullish confirmation token=supersecret-token-123456789 ${FAKE_SK_VALUE}`,
            created_at: new Date().toISOString(),
          },
          {
            analyst: 'sentiment',
            signal: 'HOLD',
            confidence: 0.55,
            reasoning: 'neutral social context',
            created_at: new Date().toISOString(),
          },
        ];
      }
      if (sql.includes('FROM investment.positions')) {
        return [{
          symbol: 'ETH/USDT',
          amount: 1,
          paper: false,
          exchange: 'binance',
          updated_at: new Date().toISOString(),
        }];
      }
      return [];
    },
    run: async (sql, params) => {
      inserts.push({ sql, params });
      return { rowCount: 1 };
    },
    callViaHub: async (...args) => {
      llmCalls.push(args);
      return {
        ok: true,
        text: JSON.stringify({
          fire: true,
          confidence: 76,
          dynamic_threshold: 68,
          position_size_pct: 12,
          reasoning: 'smoke entry 조건은 shadow 기준으로 유효',
          risk_assessment: {
            risk_level: 'medium',
            main_risk: 'volatility token=supersecret-token-123456789',
            nested: {
              api_key: FAKE_SK_VALUE,
              notes: [`Bearer ${FAKE_BEARER_VALUE}`],
            },
          },
        }),
      };
    },
  };
}

export async function runLunaEntryLlmSmoke() {
  const investmentRoot = path.resolve(import.meta.dirname, '..');
  const migration = fs.readFileSync(path.join(investmentRoot, 'migrations/20260511_luna_entry_llm_shadow.sql'), 'utf8');
  const bootstrap = fs.readFileSync(path.join(investmentRoot, 'shared/db/schema/tables/bootstrap.ts'), 'utf8');
  assert.match(migration, /luna_entry_llm_shadow/);
  assert.match(migration, /dynamic_threshold/);
  assert.match(migration, /context_evidence/);
  assert.match(bootstrap, /CREATE TABLE IF NOT EXISTS luna_entry_llm_shadow/);
  assert.match(bootstrap, /idx_luna_entry_llm_shadow_symbol_observed/);
  assert.match(bootstrap, /context_evidence/);

  const normalized = normalizeEntryLlmShadowResult({
    fire: true,
    confidence: 76,
    dynamic_threshold: 68,
    position_size_pct: 12,
    reasoning: `safe but ${FAKE_SK_VALUE} must be redacted`,
    riskAssessment: {
      risk_level: 'medium',
      main_risk: 'token=supersecret-token-123456789',
      nested: {
        api_key: FAKE_SK_VALUE,
        bearer: `Bearer ${FAKE_BEARER_VALUE}`,
      },
    },
  });
  assert.equal(normalized.fire, true);
  assert.equal(normalized.confidence, 0.76);
  assert.equal(normalized.dynamicThreshold, 0.68);
  assert.equal(normalized.positionSizePct, 0.12);
  assert.equal(normalized.shadowOnly, true);
  assert.doesNotMatch(normalized.reasoning, /sk-test-secret/);
  const normalizedRisk = JSON.stringify(normalized.riskAssessment);
  assert.doesNotMatch(normalizedRisk, /supersecret-token/);
  assert.equal(normalizedRisk.includes(FAKE_SK_VALUE), false);
  assert.equal(normalizedRisk.includes(FAKE_BEARER_VALUE), false);
  assert.equal(normalized.riskAssessment.nested.api_key, '[redacted]');

  const debate = buildEntryDecisionDebate({
    candidate: {
      confidence: 0.74,
      predictiveScore: 0.66,
    },
    fireReadiness: {
      ok: true,
      reason: 'breakout_retest_mtf_confirmed',
      details: {
        mtfAgreement: 0.82,
        discoveryScore: 0.7,
        volumeBurst: 1.9,
      },
    },
    regimeShadow: { llm_regime: 'trending_bull' },
  });
  assert.equal(debate.agents.zeusBull.stance, 'support');
  assert.equal(debate.agents.nemesisRisk.stance, 'allow_shadow');
  assert.equal(typeof debate.finalVote.fire, 'boolean');

  const sameSymbolRiskDebate = buildEntryDecisionDebate({
    candidate: {
      confidence: 0.74,
      predictiveScore: 0.66,
    },
    fireReadiness: {
      ok: true,
      reason: 'breakout_retest_mtf_confirmed',
      details: {
        mtfAgreement: 0.82,
        discoveryScore: 0.7,
        volumeBurst: 1.9,
      },
    },
    regimeShadow: { llm_regime: 'trending_bull' },
    contextEvidence: { openPositions: { sameSymbolOpen: 1, openPositionCount: 1 } },
  });
  assert.equal(sameSymbolRiskDebate.agents.nemesisRisk.reason, 'same_symbol_open_position_risk');

  const dryDeps = fakeDeps();
  const planned = await runLunaEntryLlmShadow({
    apply: false,
    confirm: '',
    exchanges: ['binance'],
    limit: 1,
    ttlMinutes: 120,
    maxLlmCalls: 3,
  }, dryDeps);
  assert.equal(planned.status, 'luna_entry_llm_shadow_planned');
  assert.equal(planned.summary.llmCalls, 0);
  assert.equal(dryDeps.inserts.length, 0);
  assert.equal(dryDeps.listCalls[0].states.includes('fired'), true);
  assert.equal(dryDeps.listCalls[0].orderBy, 'updated_desc');
  assert.equal(Boolean(dryDeps.listCalls[0].updatedAfter), true);
  assert.equal(planned.rows[0].contextEvidence.analysis.signalCounts.BUY, 1);
  assert.doesNotMatch(planned.rows[0].contextEvidence.analysis.recent[0].reasoning, /supersecret-token/);
  assert.doesNotMatch(planned.rows[0].contextEvidence.analysis.recent[0].reasoning, /sk-test-secret/);

  const applyDeps = fakeDeps();
  const written = await runLunaEntryLlmShadow({
    apply: true,
    confirm: 'luna-entry-llm-shadow',
    exchanges: ['binance'],
    limit: 1,
    ttlMinutes: 120,
    maxLlmCalls: 1,
  }, applyDeps);
  assert.equal(written.status, 'luna_entry_llm_shadow_written');
  assert.equal(written.summary.written, 1);
  assert.equal(written.summary.llmCalls, 1);
  assert.equal(applyDeps.inserts.length, 1);
  assert.equal(applyDeps.llmCalls[0][3].taskType, 'entry_decision_shadow');
  assert.match(applyDeps.llmCalls[0][2], /contextEvidence/);
  assert.doesNotMatch(applyDeps.llmCalls[0][2], /supersecret-token/);
  assert.doesNotMatch(applyDeps.llmCalls[0][2], /sk-test-secret/);
  const insertedRisk = JSON.parse(applyDeps.inserts[0].params[15]);
  const insertedRiskText = JSON.stringify(insertedRisk);
  assert.doesNotMatch(insertedRiskText, /supersecret-token/);
  assert.equal(insertedRiskText.includes(FAKE_SK_VALUE), false);
  assert.equal(insertedRiskText.includes(FAKE_BEARER_VALUE), false);
  assert.equal(insertedRisk.nested.api_key, '[redacted]');
  assert.equal(JSON.parse(applyDeps.inserts[0].params[17]).analysis.signalCounts.BUY, 1);
  assert.doesNotMatch(JSON.parse(applyDeps.inserts[0].params[17]).analysis.recent[0].reasoning, /supersecret-token/);

  const cappedDeps = fakeDeps();
  const capped = await runLunaEntryLlmShadow({
    apply: true,
    confirm: 'luna-entry-llm-shadow',
    exchanges: ['binance'],
    limit: 1,
    ttlMinutes: 120,
    maxLlmCalls: 0,
  }, cappedDeps);
  assert.equal(capped.rows[0].reason, 'llm_call_cap_reached');
  assert.equal(capped.summary.llmCalls, 0);
  assert.equal(cappedDeps.inserts.length, 0);

  const freshDeps = fakeDeps({ existingShadow: true });
  const fresh = await runLunaEntryLlmShadow({
    apply: true,
    confirm: 'luna-entry-llm-shadow',
    exchanges: ['binance'],
    limit: 1,
    ttlMinutes: 120,
    maxLlmCalls: 1,
  }, freshDeps);
  assert.equal(fresh.rows[0].reason, 'fresh_shadow_exists');
  assert.equal(fresh.summary.llmCalls, 0);

  return {
    ok: true,
    smoke: 'luna-entry-llm-shadow',
    planned: planned.status,
    written: written.status,
    capGuard: capped.rows[0].reason,
    freshGuard: fresh.rows[0].reason,
  };
}

async function main() {
  const result = await runLunaEntryLlmSmoke();
  console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna entry LLM smoke 실패:',
  });
}
