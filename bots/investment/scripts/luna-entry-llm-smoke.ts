#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { INVESTMENT_SCHEMA, pgPool } from '../shared/db/core.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildEntryDecisionDebate,
  evaluateRecallLatencyBudget,
  normalizeEntryLlmShadowResult,
} from '../shared/entry-llm-shadow-judge.ts';
import {
  fetchSimilarTradeReflections,
  queryWithStatementTimeout,
  runLunaEntryLlmShadow,
} from './runtime-luna-entry-llm-shadow.ts';

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
      if (sql.includes('luna_failure_reflexions')) {
        return [{
          trade_id: 41001,
          hindsight: 'BTC breakout 손실에서는 volatile 레짐 확인을 먼저 했어야 했다.',
          symbol: 'BTC/USDT',
          market: 'crypto',
          regime: 'volatile',
          setup_type: 'breakout',
          similarity_score: 7,
          created_at: new Date().toISOString(),
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
        await new Promise((resolve) => setTimeout(resolve, 5));
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
        await new Promise((resolve) => setTimeout(resolve, 5));
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
  assert.equal(planned.rows[0].contextEvidence.reflectionRecall.status, 'injected');
  assert.equal(planned.rows[0].contextEvidence.reflectionRecall.items.length, 1);
  assert.equal(planned.rows[0].contextEvidence.reflectionRecall.withinBudget, true);
  assert.ok(planned.rows[0].contextEvidence.reflectionRecall.increasePct <= 0.2);
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
  assert.match(applyDeps.llmCalls[0][2], /reflectionRecall/);
  assert.match(applyDeps.llmCalls[0][2], /penalty_flag_only/);
  assert.doesNotMatch(applyDeps.llmCalls[0][2], /supersecret-token/);
  assert.doesNotMatch(applyDeps.llmCalls[0][2], /sk-test-secret/);
  const insertedRisk = JSON.parse(applyDeps.inserts[0].params[15]);
  const insertedRiskText = JSON.stringify(insertedRisk);
  assert.doesNotMatch(insertedRiskText, /supersecret-token/);
  assert.equal(insertedRiskText.includes(FAKE_SK_VALUE), false);
  assert.equal(insertedRiskText.includes(FAKE_BEARER_VALUE), false);
  assert.equal(insertedRisk.nested.api_key, '[redacted]');
  assert.equal(JSON.parse(applyDeps.inserts[0].params[17]).analysis.signalCounts.BUY, 1);
  assert.equal(JSON.parse(applyDeps.inserts[0].params[17]).reflectionRecall.items.length, 1);
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

  const missingRecall = await fetchSimilarTradeReflections(async () => [], {
    symbol: 'ETH/USDT',
    market: 'crypto',
    setupType: 'mean_reversion',
    timeoutMs: 20,
  });
  assert.equal(missingRecall.status, 'empty');
  assert.deepEqual(missingRecall.items, []);

  const marketScopedRecall = await fetchSimilarTradeReflections(async () => [
    {
      trade_id: 41002,
      hindsight: '국내 종목 회고',
      symbol: '229000',
      market: 'domestic',
      regime: 'volatile',
      setup_type: 'breakout',
      similarity_score: 2,
    },
    {
      trade_id: 41003,
      hindsight: 'BTC 회고',
      symbol: 'BTC/USDT',
      market: 'crypto',
      regime: 'volatile',
      setup_type: 'breakout',
      similarity_score: 7,
    },
  ], {
    symbol: 'BTC/USDT',
    market: 'crypto',
    setupType: 'breakout',
    timeoutMs: 20,
  });
  assert.deepEqual(marketScopedRecall.items.map((item) => item.tradeId), [41003]);

  let timeoutCancelled = false;
  const timeoutRecall = await fetchSimilarTradeReflections(
    async (_sql, _params, { signal } = {}) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        timeoutCancelled = true;
        reject(signal.reason || new Error('aborted'));
      }, { once: true });
    }),
    { symbol: 'ETH/USDT', market: 'crypto', setupType: 'mean_reversion', timeoutMs: 5 },
  );
  assert.equal(timeoutRecall.status, 'timeout');
  assert.deepEqual(timeoutRecall.items, []);
  assert.equal(timeoutCancelled, true);

  const budgetDeps = fakeDeps();
  const baselineQuery = budgetDeps.query;
  budgetDeps.query = async (sql, ...args) => {
    if (sql.includes('FROM investment.analysis') || sql.includes('FROM investment.positions')) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return baselineQuery(sql, ...args);
  };
  let budgetCancelled = false;
  budgetDeps.reflectionRecallQuery = async (_sql, _params, { signal } = {}) => new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => {
      budgetCancelled = true;
      reject(signal.reason || new Error('aborted'));
    }, { once: true });
  });
  const budgetExceeded = await runLunaEntryLlmShadow({
    apply: false,
    confirm: '',
    exchanges: ['binance'],
    limit: 1,
    ttlMinutes: 120,
    maxLlmCalls: 0,
  }, budgetDeps);
  assert.equal(budgetExceeded.rows[0].contextEvidence.reflectionRecall.status, 'budget_exceeded');
  assert.equal(budgetCancelled, true);

  const isolatedBaselineDeps = fakeDeps();
  const isolatedBaselineQuery = isolatedBaselineDeps.query;
  let baselineCompletions = 0;
  let recallStartedAfterBaselineQueries = false;
  isolatedBaselineDeps.query = async (sql, ...args) => {
    if (sql.includes('FROM investment.analysis') || sql.includes('FROM investment.positions')) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      baselineCompletions += 1;
    }
    return isolatedBaselineQuery(sql, ...args);
  };
  isolatedBaselineDeps.reflectionRecallQuery = async () => {
    recallStartedAfterBaselineQueries = baselineCompletions === 2;
    return [];
  };
  await runLunaEntryLlmShadow({
    apply: false,
    confirm: '',
    exchanges: ['binance'],
    limit: 1,
    ttlMinutes: 120,
    maxLlmCalls: 0,
  }, isolatedBaselineDeps);
  assert.equal(recallStartedAfterBaselineQueries, true);

  await assert.rejects(
    queryWithStatementTimeout('SELECT pg_sleep(0.05)', [], { timeoutMs: 5 }),
    (error) => error?.code === '57014',
  );
  const queryController = new AbortController();
  const queryCancellation = queryWithStatementTimeout(
    'SELECT pg_sleep(0.1)',
    [],
    { timeoutMs: 200, signal: queryController.signal },
  );
  setTimeout(() => queryController.abort(new Error('smoke_budget_exceeded')), 20);
  await assert.rejects(queryCancellation, (error) => error?.code === '57014');

  const targetPool = pgPool.getPool(INVESTMENT_SCHEMA);
  assert.equal(targetPool.options.max, 2);
  const blocker = await targetPool.connect();
  try {
    const saturatedController = new AbortController();
    const startedAt = performance.now();
    const saturatedCancellation = queryWithStatementTimeout(
      'SELECT pg_sleep(1)',
      [],
      { timeoutMs: 200, signal: saturatedController.signal },
    );
    setTimeout(() => saturatedController.abort(new Error('smoke_pool_saturated')), 40);
    await assert.rejects(saturatedCancellation, (error) => error?.code === '57014');
    assert.ok(
      performance.now() - startedAt < 150,
      'abort cancellation must not wait for a target-pool connection',
    );
  } finally {
    blocker.release();
  }

  assert.equal(evaluateRecallLatencyBudget({ baselineMs: 100, totalMs: 119 }).withinBudget, true);
  assert.equal(evaluateRecallLatencyBudget({ baselineMs: 100, totalMs: 121 }).withinBudget, false);

  return {
    ok: true,
    smoke: 'luna-entry-llm-shadow',
    planned: planned.status,
    written: written.status,
    capGuard: capped.rows[0].reason,
    freshGuard: fresh.rows[0].reason,
    recallFallback: missingRecall.status,
    recallTimeout: timeoutRecall.status,
    recallLatency: {
      baselineMs: planned.rows[0].contextEvidence.reflectionRecall.baselineMs,
      totalMs: planned.rows[0].contextEvidence.reflectionRecall.totalMs,
      increasePct: planned.rows[0].contextEvidence.reflectionRecall.increasePct,
      withinBudget: planned.rows[0].contextEvidence.reflectionRecall.withinBudget,
    },
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
