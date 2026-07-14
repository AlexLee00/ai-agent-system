#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  generateAndPersistTradeReflection,
  normalizeTradeReflectionText,
  reflectionReasonSimilarity,
} from '../shared/luna-trade-reflection.ts';
import {
  buildLunaReflectionDedupeReason,
  isLunaReflectionDuplicateReason,
  normalizeLunaReflectionText,
  normalizeLunaMarketKey,
} from '../shared/luna-data-contracts.ts';
import {
  persistTradeQualityReflection,
  fetchRejectedReflexionRetryCandidates,
} from '../shared/trade-quality-evaluator.ts';
import {
  FAILURE_REFLEXION_INSERT_SQL,
  evaluateAnalystCalls,
} from '../shared/luna-feedback-loop-orchestrator.ts';
import { isAnalystPredictionCorrect } from '../shared/analyst-prediction-correctness.ts';
import { ensureDailyReflexionBudget } from '../shared/posttrade-reflexion-budget.ts';
import { fetchSimilarTradeReflections } from './runtime-luna-entry-llm-shadow.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { LUNA_DATA_CONTRACT_BOUNDARY_FIXTURES } from './luna-data-contract-boundary-fixtures.ts';

function fixture(overrides = {}) {
  return {
    tradeId: '52001',
    market: 'crypto',
    symbol: 'BTC/USDT',
    side: 'buy',
    paper: true,
    pnlPct: -1.4,
    holdingHours: 5,
    strategyProfile: 'breakout',
    regime: 'volatile',
    analystCalls: [
      { botName: 'aria', prediction: 'bullish', confidence: 0.78 },
      { botName: 'sophia', prediction: 'bearish', confidence: 0.61 },
    ],
    ...overrides,
  };
}

export async function runLunaPhaseAReflexionSmoke() {
  assert.match(FAILURE_REFLEXION_INSERT_SQL, /ON CONFLICT \(trade_id\) DO NOTHING/i);
  assert.doesNotMatch(FAILURE_REFLEXION_INSERT_SQL, /ON CONFLICT \(trade_id\) DO UPDATE/i);

  assert.equal(
    normalizeTradeReflectionText('첫째입니다. 둘째입니다. 셋째입니다. 넷째입니다.'),
    '첫째입니다. 둘째입니다. 셋째입니다.',
  );
  assert.equal(
    normalizeLunaReflectionText(LUNA_DATA_CONTRACT_BOUNDARY_FIXTURES.decimalReflection.input),
    LUNA_DATA_CONTRACT_BOUNDARY_FIXTURES.decimalReflection.expected,
  );
  assert.equal(
    normalizeTradeReflectionText(LUNA_DATA_CONTRACT_BOUNDARY_FIXTURES.decimalReflection.input),
    LUNA_DATA_CONTRACT_BOUNDARY_FIXTURES.decimalReflection.expected,
  );
  assert.ok(reflectionReasonSimilarity(
    'volatile breakout에서 bullish 예측이 손실과 불일치',
    'volatile breakout bullish 예측 손실 불일치',
  ) >= 0.8);
  for (const directionCase of LUNA_DATA_CONTRACT_BOUNDARY_FIXTURES.directionCases) {
    assert.equal(
      isAnalystPredictionCorrect(
        directionCase.prediction,
        directionCase.side,
        directionCase.profitable,
      ),
      directionCase.expected,
    );
  }
  const oppositeSideReasons = LUNA_DATA_CONTRACT_BOUNDARY_FIXTURES.oppositeSideDedupe.sides
    .map((side) => buildLunaReflectionDedupeReason({
      ...LUNA_DATA_CONTRACT_BOUNDARY_FIXTURES.oppositeSideDedupe.common,
      side,
    }));
  assert.notEqual(oppositeSideReasons[0], oppositeSideReasons[1]);
  assert.equal(isLunaReflectionDuplicateReason(oppositeSideReasons[0], oppositeSideReasons[1]), false);
  assert.equal(normalizeLunaMarketKey('stocks'), 'domestic');
  assert.equal(normalizeLunaMarketKey('KIS'), 'domestic');
  assert.equal(normalizeLunaMarketKey('KIS_OVERSEAS'), 'overseas');

  const reflectionPayloads = [];
  await persistTradeQualityReflection({
    tradeId: 52006,
    trade: {
      symbol: '005930',
      market: 'stocks',
      direction: 'long',
      entry_price: 70_000,
      exit_price: 71_400,
      entry_at: '2026-07-13T00:00:00.000Z',
      exit_at: '2026-07-13T04:00:00.000Z',
      setup_type: 'breakout',
    },
    breakdown: { pnl_pct: 2, hold_hours: 4 },
    reviewData: { strategy_family: 'momentum', regime: 'risk_on' },
    analystData: { aria_accurate: true, sophia_accurate: false },
  }, async (payload) => {
    reflectionPayloads.push(payload);
    return { persisted: true, source: 'fixture' };
  });
  assert.equal(reflectionPayloads.length, 1);
  assert.equal(reflectionPayloads[0].market, 'domestic');
  assert.equal(reflectionPayloads[0].side, 'buy');
  assert.equal(reflectionPayloads[0].pnlPct, 2);
  assert.equal(reflectionPayloads[0].holdingHours, 4);
  assert.equal(reflectionPayloads[0].strategyProfile, 'momentum');
  assert.deepEqual(
    reflectionPayloads[0].analystCalls.map(({ botName, accurate }) => [botName, accurate]),
    [['aria', true], ['sophia', false]],
  );

  let gatedReflectionCalls = 0;
  const disabledReflection = await persistTradeQualityReflection({
    tradeId: 52008,
    category: 'neutral',
    trade: { symbol: 'BTC/USDT', market: 'crypto', direction: 'long' },
  }, async () => {
    gatedReflectionCalls += 1;
    return { persisted: true, source: 'fixture' };
  }, {
    reflexionConfig: { enabled: false, llm_daily_budget_usd: 3 },
    ensureBudget: async () => ({ ok: true, usedEstimateUsd: 0 }),
  });
  assert.equal(disabledReflection.skipped, true);
  assert.equal(disabledReflection.reason, 'reflexion_disabled');
  assert.equal(gatedReflectionCalls, 0);

  const rejectedReflection = await persistTradeQualityReflection({
    tradeId: 52009,
    category: 'rejected',
    trade: { symbol: 'BTC/USDT', market: 'crypto', direction: 'long' },
  }, async () => {
    gatedReflectionCalls += 1;
    return { persisted: true, source: 'fixture' };
  }, {
    reflexionConfig: { enabled: true, llm_daily_budget_usd: 3 },
    ensureBudget: async () => ({ ok: true, usedEstimateUsd: 0 }),
  });
  assert.equal(rejectedReflection.reason, 'phase_c_owns_rejected');
  assert.equal(gatedReflectionCalls, 0);

  const budgetBlockedReflection = await persistTradeQualityReflection({
    tradeId: 52010,
    category: 'neutral',
    trade: { symbol: 'BTC/USDT', market: 'crypto', direction: 'long' },
  }, async () => {
    gatedReflectionCalls += 1;
    return { persisted: true, source: 'fixture' };
  }, {
    reflexionConfig: { enabled: true, llm_daily_budget_usd: 3 },
    ensureBudget: async () => ({ ok: false, usedEstimateUsd: 3.04 }),
  });
  assert.equal(budgetBlockedReflection.reason, 'reflexion_llm_daily_budget_exceeded');
  assert.equal(gatedReflectionCalls, 0);

  let budgetSql = '';
  const availableBudget = await ensureDailyReflexionBudget({
    budgetUsd: 3,
    getFn: async (sql) => {
      budgetSql = sql;
      return { cnt: 74 };
    },
  });
  assert.equal(availableBudget.ok, true);
  assert.match(budgetSql, /investment\.luna_failure_reflexions/);
  assert.match(budgetSql, /investment\.trade_quality_evaluations/);
  const exhaustedBudget = await ensureDailyReflexionBudget({
    budgetUsd: 3,
    getFn: async () => ({ cnt: 75 }),
  });
  assert.equal(exhaustedBudget.ok, false);

  let recallSql = '';
  let recallParams = [];
  const historicalRecall = await fetchSimilarTradeReflections(async (sql, params) => {
    recallSql = sql;
    recallParams = params;
    return [
      {
        trade_id: '51001',
        hindsight: 'BTC 과거 회고',
        symbol: 'BTC/USDT && volatility<0.5%',
        market: 'crypto',
        similarity_score: 4,
      },
      {
        trade_id: '51002',
        hindsight: 'ETH 과거 회고',
        symbol: 'ETH',
        market: null,
        similarity_score: 4,
      },
      {
        trade_id: '51003',
        hindsight: '다른 시장 회고',
        symbol: 'BTC/USDT',
        market: 'overseas',
        similarity_score: 4,
      },
      {
        trade_id: '51004',
        hindsight: '시장 불명 BTC 회고',
        symbol: 'BTC/USDT',
        market: null,
        similarity_score: 4,
      },
    ];
  }, {
    symbol: 'BTC/USDT',
    market: 'binance',
  });
  assert.equal(recallParams[0], 'crypto');
  assert.match(recallSql, /symbol_pattern/);
  assert.match(recallSql, /avoid_pattern->>'market'/);
  assert.match(recallSql, /investment\.trade_journal/);
  assert.deepEqual(historicalRecall.items.map((item) => item.tradeId), ['51001']);

  const retryCandidates = await fetchRejectedReflexionRetryCandidates({
    limit: 10,
    queryFn: async () => [
      {
        trade_id: 52002,
        dedupe_of_trade_id: 52001,
        canonical_failure_trade_id: 52001,
      },
      {
        trade_id: 52003,
        dedupe_of_trade_id: null,
        canonical_failure_trade_id: null,
      },
    ],
  });
  assert.deepEqual(retryCandidates.map((candidate) => candidate.tradeId), [52003]);

  const writes = [];
  const llmCalls = [];
  const generated = await generateAndPersistTradeReflection(fixture(), {
    query: async () => [],
    run: async (sql, params) => {
      writes.push({ sql, params });
      return { rowCount: 1 };
    },
    callLLM: async (...args) => {
      llmCalls.push(args);
      return '아리아의 bullish 판단은 변동성 레짐에서 손실과 어긋났습니다. 소피아의 bearish 경고는 맞았습니다. 다음에는 레짐과 반대되는 진입 전에 하방 경고를 다시 확인합니다. 이 문장은 잘려야 합니다.';
    },
  });
  assert.equal(generated.source, 'llm');
  assert.equal(generated.reflection.outcome, 'incorrect');
  assert.equal(generated.reflection.text.split(/[.!?](?:\s|$)/).filter(Boolean).length, 3);
  assert.equal(llmCalls.length, 1);
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /UPDATE investment\.trade_quality_evaluations/);
  assert.doesNotMatch(writes[0].sql, /INSERT INTO/);

  const dedupeWrites = [];
  let dedupeLlmCalls = 0;
  const deduped = await generateAndPersistTradeReflection(fixture({ tradeId: '52002' }), {
    query: async () => [{
      trade_id: 52001,
      reflection: {
        text: generated.reflection.text,
        reason: generated.reflection.reason,
      },
    }],
    run: async (sql, params) => {
      dedupeWrites.push({ sql, params });
      return { rowCount: 1 };
    },
    callLLM: async () => {
      dedupeLlmCalls += 1;
      return '호출되면 안 됩니다.';
    },
  });
  assert.equal(deduped.source, 'deduplicated');
  assert.equal(deduped.reflection.dedupeOfTradeId, 52001);
  assert.equal(dedupeLlmCalls, 0);
  assert.equal(dedupeWrites.length, 1);

  let oppositeSideLlmCalls = 0;
  const oppositeSide = await generateAndPersistTradeReflection({
    ...LUNA_DATA_CONTRACT_BOUNDARY_FIXTURES.oppositeSideDedupe.common,
    tradeId: '52005',
    side: 'sell',
  }, {
    query: async () => [{
      trade_id: 52004,
      reflection: {
        text: '매수 돌파 판단이 맞았습니다.',
        reason: buildLunaReflectionDedupeReason({
          ...LUNA_DATA_CONTRACT_BOUNDARY_FIXTURES.oppositeSideDedupe.common,
          side: 'buy',
        }),
      },
    }],
    run: async () => ({ rowCount: 1 }),
    callLLM: async () => {
      oppositeSideLlmCalls += 1;
      return '매도 돌파 판단을 별도로 검토했습니다.';
    },
  });
  assert.equal(oppositeSide.source, 'llm');
  assert.equal(oppositeSideLlmCalls, 1);
  assert.match(oppositeSide.reflection.reason, /side\/sell/);

  const fallback = await generateAndPersistTradeReflection(fixture({ tradeId: '52003', pnlPct: 1.2 }), {
    query: async () => [],
    run: async () => ({ rowCount: 1 }),
    callLLM: async () => {
      throw new Error('fixture_llm_unavailable');
    },
  });
  assert.equal(fallback.source, 'rule_based_fallback');
  assert.equal(fallback.reflection.outcome, 'correct');
  assert.ok(fallback.reflection.text.length > 0);

  const profitableSell = await generateAndPersistTradeReflection(fixture({
    tradeId: '52004',
    side: 'sell',
    pnlPct: 1.2,
  }), {
    query: async () => [],
    run: async () => ({ rowCount: 1 }),
    callLLM: async () => {
      throw new Error('fixture_llm_unavailable');
    },
  });
  assert.match(profitableSell.reflection.reason, /aria:bullish:incorrect/);
  assert.match(profitableSell.reflection.reason, /sophia:bearish:correct/);
  assert.match(profitableSell.reflection.text, /sophia 판단은 맞았습니다/);
  assert.match(profitableSell.reflection.text, /aria 판단은 틀렸습니다/);

  const explicitAccuracy = await generateAndPersistTradeReflection(fixture({
    tradeId: '52007',
    analystCalls: [
      { botName: 'aria', prediction: 'neutral', confidence: 0, accurate: true },
      { botName: 'sophia', prediction: 'neutral', confidence: 0, accurate: false },
    ],
  }), {
    query: async () => [],
    run: async () => ({ rowCount: 1 }),
    callLLM: async () => {
      throw new Error('fixture_llm_unavailable');
    },
  });
  assert.match(explicitAccuracy.reflection.reason, /aria:neutral:correct/);
  assert.match(explicitAccuracy.reflection.reason, /sophia:neutral:incorrect/);
  assert.match(explicitAccuracy.reflection.text, /aria 판단은 맞았습니다/);
  assert.match(explicitAccuracy.reflection.text, /sophia 판단은 틀렸습니다/);
  assert.deepEqual(
    evaluateAnalystCalls(fixture({ side: 'sell', pnlPct: 1.2 }))
      .map(({ call, accurate }) => [call.botName, accurate]),
    [['aria', false], ['sophia', true]],
  );

  return {
    ok: true,
    generated: generated.source,
    dedupe: deduped.source,
    fallback: fallback.source,
    sentenceCount: generated.reflection.text.split(/[.!?](?:\s|$)/).filter(Boolean).length,
  };
}

async function main() {
  console.log(JSON.stringify(await runLunaPhaseAReflexionSmoke(), null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'luna phase A reflexion smoke failed:',
  });
}
