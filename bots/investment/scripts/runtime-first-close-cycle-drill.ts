#!/usr/bin/env node
// @ts-nocheck
/**
 * runtime-first-close-cycle-drill.ts
 *
 * Phase Z2~Z7 paper-only close-cycle drill.
 * Creates a deterministic BUY -> SELL -> close event -> posttrade -> reflexion path
 * without touching live order execution.
 */

import * as db from '../shared/db.ts';
import { recordPositionLifecycleStageEvent } from '../shared/lifecycle-contract.ts';
import { runPosttradeFeedbackWorker } from './runtime-posttrade-feedback-worker.ts';
import { runFirstBuyCycleVerify } from './runtime-first-buy-cycle-verify.ts';
import { runFirstCycleLifecycleTrace } from './runtime-first-cycle-lifecycle-trace.ts';
import { runFirstCycleCloseVerify } from './runtime-first-cycle-close-verify.ts';
import { runFirstCyclePosttradeVerify } from './runtime-first-cycle-posttrade-verify.ts';
import { runFirstCycleReflexionVerify } from './runtime-first-cycle-reflexion-verify.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
    cleanup: argv.includes('--cleanup'),
    cleanupOnly: argv.includes('--cleanup-only'),
    symbol: argv.find((arg) => arg.startsWith('--symbol='))?.split('=')[1] || 'LUNA_FIRST_CLOSE_CYCLE/USDT',
    exchange: argv.find((arg) => arg.startsWith('--exchange='))?.split('=')[1] || 'binance',
    maxUsdt: Math.min(50, Math.max(1, Number(argv.find((arg) => arg.startsWith('--max-usdt='))?.split('=')[1] || process.env.LUNA_FIRST_CYCLE_MAX_USDT || 50))),
  };
}

function nowIso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

async function insertSignal({ symbol, action, exchange, amountUsdt, confidence, reasoning, tradeMode }) {
  return db.insertSignal({
    symbol,
    action,
    amountUsdt,
    confidence,
    reasoning,
    status: 'EXECUTED',
    exchange,
    tradeMode,
    approvedAt: new Date().toISOString(),
    strategyFamily: 'first_close_cycle',
    strategyQuality: 'validation_paper',
    strategyReadiness: 0.9,
    executionOrigin: 'first_close_cycle_paper_drill',
    qualityFlag: 'trusted',
    excludeFromLearning: false,
  });
}

async function insertTradeRow({
  id,
  signalId,
  symbol,
  side,
  amount,
  price,
  totalUsdt,
  exchange,
  tradeMode,
  executedAt,
}) {
  await db.run(
    `INSERT INTO trades
       (id, signal_id, symbol, side, amount, price, total_usdt, paper, exchange,
        executed_at, tp_sl_set, trade_mode, execution_origin, quality_flag,
        exclude_from_learning, incident_link)
     VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,$9,true,$10,$11,'trusted',false,$12)`,
    [
      String(id),
      signalId ? String(signalId) : null,
      symbol,
      side,
      amount,
      price,
      totalUsdt,
      exchange,
      executedAt,
      tradeMode,
      side === 'buy' ? 'first_close_cycle_paper_buy' : 'first_close_cycle_paper_forced_loss_close',
      `first_close_cycle:${id}`,
    ],
  );
}

async function recordLifecycle({ symbol, exchange, tradeMode, signalId, buyTradeId, sellTradeId }) {
  const common = { symbol, exchange, tradeMode, ownerAgent: 'luna_first_close_cycle_drill' };
  const stageEvents = [
    ['stage_1', 'discovery_collect', { signalId, buyTradeId }],
    ['stage_2', 'strategy_analyze', { setupType: 'first_close_cycle' }],
    ['stage_3', 'risk_approved', { maxUsdt: Number(process.env.LUNA_FIRST_CYCLE_MAX_USDT || 50) }],
    ['stage_4', 'paper_buy_recorded', { tradeId: buyTradeId }],
    ['stage_5', 'strategy_validity_check', { action: 'EXIT', reason: 'first_cycle_close_validation' }],
    ['stage_6', 'paper_sell_recorded', { tradeId: sellTradeId }],
    ['stage_7', 'review_created', { tradeId: sellTradeId }],
    ['stage_8', 'feedback_applied', { tradeId: sellTradeId }],
  ];

  for (const [stageId, eventType, outputSnapshot] of stageEvents) {
    await recordPositionLifecycleStageEvent({
      ...common,
      stageId,
      eventType,
      outputSnapshot,
      evidenceSnapshot: {
        paperOnly: true,
        firstCloseCycle: true,
      },
      idempotencyKey: `first-close-cycle:${sellTradeId}:${stageId}`,
    });
  }
}

async function insertTradeReview({ sellTradeId }) {
  await db.run(
    `INSERT INTO investment.trade_review
       (trade_id, entry_timing, exit_timing, signal_accuracy,
        risk_managed, tp_sl_protected, execution_speed,
        max_favorable, max_adverse,
        aria_accurate, sophia_accurate, oracle_accurate, hermes_accurate,
        luna_review, lessons_learned, strategy_adjustment, analyst_accuracy, reviewed_at)
     VALUES ($1,'validation','forced_validation_close','validation',true,true,'instant',
             0.2,-1.1,false,true,true,true,
             'first close cycle paper drill',
             'paper-only close loop verified before live exposure',
             'keep first cycle guard active until live approval',
             $2, $3)`,
    [
      String(sellTradeId),
      JSON.stringify({ aria: false, sophia: true, oracle: true, hermes: true }),
      Date.now(),
    ],
  ).catch(() => {});
}

async function insertCloseArtifacts({ symbol, exchange, tradeMode, buyTradeId, sellTradeId, buySignalId, sellSignalId, amount, buyPrice, sellPrice }) {
  await db.insertCloseoutReview({
    signalId: sellSignalId ? String(sellSignalId) : null,
    tradeId: String(sellTradeId),
    exchange,
    symbol,
    tradeMode,
    closeoutType: 'full_exit',
    closeoutReason: 'first_close_cycle_paper_forced_loss_close',
    plannedRatio: 1,
    executedRatio: 1,
    plannedNotional: amount * buyPrice,
    executedNotional: amount * sellPrice,
    pnlRealized: (sellPrice - buyPrice) * amount,
    setupType: 'first_close_cycle',
    strategyFamily: 'first_close_cycle',
    reviewStatus: 'completed',
    reviewResult: {
      buyTradeId,
      sellTradeId,
      buySignalId,
      sellSignalId,
      paperOnly: true,
    },
    idempotencyKey: `first-close-cycle-review:${sellTradeId}`,
  });

  const eventPayload = {
    symbol,
    exchange,
    market: 'crypto',
    trade_id: sellTradeId,
    buy_trade_id: buyTradeId,
    close_event_id: `first-close-cycle:${sellTradeId}`,
    paper_only: true,
    first_close_cycle: true,
    posttrade_processed: false,
  };
  await db.run(
    `INSERT INTO investment.mapek_knowledge (event_type, payload)
     VALUES ('position_closed', $1), ('quality_evaluation_pending', $2)`,
    [JSON.stringify(eventPayload), JSON.stringify(eventPayload)],
  );

  await db.run(
    `INSERT INTO luna_rag_documents
       (owner_agent, category, market, symbol, content, metadata)
     VALUES ('luna','thesis','crypto',$1,$2,$3)`,
    [
      symbol,
      'First close cycle paper drill thesis: validate BUY -> SELL -> posttrade -> reflexion before live exposure.',
      JSON.stringify({ trade_id: String(sellTradeId), buy_trade_id: String(buyTradeId), first_close_cycle: true }),
    ],
  ).catch(() => {});
}

async function cleanupFirstCloseCycleArtifacts({
  symbol,
  exchange,
  tradeMode,
  buyTradeId = null,
  sellTradeId = null,
  buySignalId = null,
  sellSignalId = null,
  knowledgeIds = [],
}) {
  const normalizeIds = (ids = []) => ids
    .filter((id) => id !== null && id !== undefined && String(id).trim() !== '')
    .map((id) => String(id));
  const tradeIds = normalizeIds([buyTradeId, sellTradeId]);
  const signalIds = normalizeIds([buySignalId, sellSignalId]);
  const extraKnowledgeIds = normalizeIds(knowledgeIds);
  const syntheticScope = String(symbol || '').startsWith('LUNA_FIRST_CLOSE_CYCLE');
  const summary = {
    requested: true,
    symbol,
    exchange,
    tradeMode,
    syntheticScope,
    tradeIds,
    signalIds,
    knowledgeIds: extraKnowledgeIds,
    deleted: {},
  };
  const record = async (key, sql, params = []) => {
    const result = await db.run(sql, params).catch(() => null);
    summary.deleted[key] = Number(result?.rowCount || 0);
  };

  await record(
    'tradeDecisionAttribution',
    `DELETE FROM investment.trade_decision_attribution tda
      WHERE tda.trade_id::text = ANY($1::text[])
         OR ($4::boolean AND tda.trade_id::text IN (
              SELECT id::text FROM trades
               WHERE symbol = $2 AND paper = true AND COALESCE(trade_mode, 'normal') = $3
            ))`,
    [tradeIds, symbol, tradeMode, syntheticScope],
  );
  await record(
    'tradeQualityEvaluations',
    `DELETE FROM investment.trade_quality_evaluations tqe
      WHERE tqe.trade_id::text = ANY($1::text[])
         OR ($4::boolean AND tqe.trade_id::text IN (
              SELECT id::text FROM trades
               WHERE symbol = $2 AND paper = true AND COALESCE(trade_mode, 'normal') = $3
            ))`,
    [tradeIds, symbol, tradeMode, syntheticScope],
  );
  await record(
    'failureReflexions',
    `DELETE FROM investment.luna_failure_reflexions lfr
      WHERE lfr.trade_id::text = ANY($1::text[])
         OR ($4::boolean AND (
              lfr.trade_id::text IN (
                SELECT id::text FROM trades
                 WHERE symbol = $2 AND paper = true AND COALESCE(trade_mode, 'normal') = $3
              )
              OR lfr.avoid_pattern::text ILIKE '%' || $2 || '%'
              OR lfr.avoid_pattern::text ILIKE '%LUNA_FIRST_CLOSE_CYCLE%'
            ))`,
    [tradeIds, symbol, tradeMode, syntheticScope],
  );
  await record(
    'tradeReview',
    `DELETE FROM investment.trade_review tr
      WHERE tr.trade_id::text = ANY($1::text[])
         OR ($4::boolean AND tr.trade_id::text IN (
              SELECT id::text FROM trades
               WHERE symbol = $2 AND paper = true AND COALESCE(trade_mode, 'normal') = $3
            ))`,
    [tradeIds, symbol, tradeMode, syntheticScope],
  );
  await record(
    'closeoutReviews',
    `DELETE FROM investment.position_closeout_reviews
      WHERE trade_id = ANY($1::text[])
         OR signal_id = ANY($2::text[])
         OR idempotency_key = $3
         OR ($6::boolean AND symbol = $4 AND COALESCE(trade_mode, 'normal') = $5)`,
    [tradeIds, signalIds, `first-close-cycle-review:${sellTradeId}`, symbol, tradeMode, syntheticScope],
  );
  await record(
    'lifecycleEvents',
    `DELETE FROM investment.position_lifecycle_events
      WHERE idempotency_key LIKE $1
         OR output_snapshot->>'tradeId' = ANY($2::text[])
         OR output_snapshot->>'buyTradeId' = ANY($2::text[])
         OR ($6::boolean AND symbol = $3 AND exchange = $4 AND COALESCE(trade_mode, 'normal') = $5)`,
    [`first-close-cycle:${sellTradeId}:%`, tradeIds, symbol, exchange, tradeMode, syntheticScope],
  );
  await record(
    'mapekKnowledge',
    `DELETE FROM investment.mapek_knowledge
      WHERE id::text = ANY($1::text[])
         OR payload->>'trade_id' = ANY($2::text[])
         OR payload->>'buy_trade_id' = ANY($2::text[])
         OR payload->>'close_event_id' = $3
         OR ($5::boolean AND (
              payload->>'symbol' = $4
              OR payload::text ILIKE '%LUNA_FIRST_CLOSE_CYCLE%'
            ))`,
    [extraKnowledgeIds, tradeIds, `first-close-cycle:${sellTradeId}`, symbol, syntheticScope],
  );
  await record(
    'lunaRagDocuments',
    `DELETE FROM luna_rag_documents
      WHERE metadata->>'trade_id' = ANY($1::text[])
         OR metadata->>'buy_trade_id' = ANY($1::text[])
         OR ($3::boolean AND (
              symbol = $2
              OR metadata::text ILIKE '%LUNA_FIRST_CLOSE_CYCLE%'
              OR content ILIKE '%LUNA_FIRST_CLOSE_CYCLE%'
            ))`,
    [tradeIds, symbol, syntheticScope],
  );
  await record(
    'positions',
    `DELETE FROM positions
      WHERE symbol = $1
        AND exchange = $2
        AND COALESCE(trade_mode, 'normal') = $3
        AND paper = true
        AND $4::boolean`,
    [symbol, exchange, tradeMode, syntheticScope],
  );
  await record(
    'trades',
    `DELETE FROM trades
      WHERE paper = true
        AND (
          id::text = ANY($1::text[])
          OR ($4::boolean AND symbol = $2 AND COALESCE(trade_mode, 'normal') = $3)
        )`,
    [tradeIds, symbol, tradeMode, syntheticScope],
  );
  await record(
    'signals',
    `DELETE FROM signals
      WHERE id::text = ANY($1::text[])
         OR ($4::boolean AND symbol = $2 AND strategy_family = $3)`,
    [signalIds, symbol, 'first_close_cycle', syntheticScope],
  );
  return summary;
}

async function withPosttradeEnv(fn) {
  const keys = [
    'LUNA_TRADE_QUALITY_EVALUATOR_ENABLED',
    'LUNA_STAGE_ATTRIBUTION_ENABLED',
    'LUNA_REFLEXION_ENGINE_ENABLED',
    'LUNA_POSTTRADE_SKILL_EXTRACTION_ENABLED',
    'LUNA_FIRST_CYCLE_RULE_BASED_POSTTRADE',
    'LUNA_FIRST_CYCLE_FORCE_RULE_BASED_POSTTRADE',
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.LUNA_TRADE_QUALITY_EVALUATOR_ENABLED = 'true';
  process.env.LUNA_STAGE_ATTRIBUTION_ENABLED = 'true';
  process.env.LUNA_REFLEXION_ENGINE_ENABLED = 'true';
  process.env.LUNA_POSTTRADE_SKILL_EXTRACTION_ENABLED = 'true';
  process.env.LUNA_FIRST_CYCLE_RULE_BASED_POSTTRADE = 'true';
  process.env.LUNA_FIRST_CYCLE_FORCE_RULE_BASED_POSTTRADE = 'true';
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export async function runFirstCloseCycleDrill(input = {}) {
  const args = { ...parseArgs([]), ...(input || {}) };
  await db.initSchema();
  const tradeMode = 'first_close_cycle';
  if (args.cleanupOnly) {
    return {
      ok: true,
      phase: 'Z2_Z7',
      status: 'first_close_cycle_artifacts_cleanup_only',
      cleanup: await cleanupFirstCloseCycleArtifacts({
        symbol: args.symbol,
        exchange: args.exchange,
        tradeMode,
      }),
    };
  }
  const runId = Date.now();
  const buyTradeId = runId;
  const sellTradeId = runId + 1;
  const buyPrice = 100_000;
  const sellPrice = 99_200;
  const amount = Number((args.maxUsdt / buyPrice).toFixed(8));
  const buyTotal = Number((amount * buyPrice).toFixed(4));
  const sellTotal = Number((amount * sellPrice).toFixed(4));

  const buySignalId = await insertSignal({
    symbol: args.symbol,
    action: 'BUY',
    exchange: args.exchange,
    amountUsdt: buyTotal,
    confidence: 0.82,
    reasoning: 'Phase Z2 first close cycle paper BUY',
    tradeMode,
  });
  await insertTradeRow({
    id: buyTradeId,
    signalId: buySignalId,
    symbol: args.symbol,
    side: 'buy',
    amount,
    price: buyPrice,
    totalUsdt: buyTotal,
    exchange: args.exchange,
    tradeMode,
    executedAt: nowIso(-120_000),
  });
  await db.upsertPosition({
    symbol: args.symbol,
    amount,
    avgPrice: buyPrice,
    unrealizedPnl: 0,
    exchange: args.exchange,
    paper: true,
    tradeMode,
  });

  const buyVerify = await runFirstBuyCycleVerify({
    exchange: args.exchange,
    tradeId: buyTradeId,
    hours: 24,
  });

  const sellSignalId = await insertSignal({
    symbol: args.symbol,
    action: 'SELL',
    exchange: args.exchange,
    amountUsdt: sellTotal,
    confidence: 0.9,
    reasoning: 'Phase Z4 first close cycle paper SELL',
    tradeMode,
  });
  await insertTradeRow({
    id: sellTradeId,
    signalId: sellSignalId,
    symbol: args.symbol,
    side: 'sell',
    amount,
    price: sellPrice,
    totalUsdt: sellTotal,
    exchange: args.exchange,
    tradeMode,
    executedAt: nowIso(-30_000),
  });
  await db.upsertPosition({
    symbol: args.symbol,
    amount: 0,
    avgPrice: buyPrice,
    unrealizedPnl: 0,
    exchange: args.exchange,
    paper: true,
    tradeMode,
  });
  await insertTradeReview({ sellTradeId });
  await recordLifecycle({
    symbol: args.symbol,
    exchange: args.exchange,
    tradeMode,
    signalId: buySignalId,
    buyTradeId,
    sellTradeId,
  });
  await insertCloseArtifacts({
    symbol: args.symbol,
    exchange: args.exchange,
    tradeMode,
    buyTradeId,
    sellTradeId,
    buySignalId,
    sellSignalId,
    amount,
    buyPrice,
    sellPrice,
  });

  const lifecycleTrace = await runFirstCycleLifecycleTrace({
    exchange: args.exchange,
    symbol: args.symbol,
    hours: 24,
  });
  const closeVerifyBeforePosttrade = await runFirstCycleCloseVerify({
    exchange: args.exchange,
    symbol: args.symbol,
    hours: 24,
  });
  const posttradeWorker = await withPosttradeEnv(() => runPosttradeFeedbackWorker({
    force: true,
    dryRun: false,
    once: true,
    market: 'crypto',
    limit: 5,
  }));
  const posttradeVerify = await runFirstCyclePosttradeVerify({
    exchange: args.exchange,
    symbol: args.symbol,
    tradeId: sellTradeId,
    hours: 24,
  });
  const reflexionVerify = await runFirstCycleReflexionVerify({
    symbol: args.symbol,
    market: 'crypto',
    hours: 24,
    dryRun: true,
  });
  const closeVerifyAfterPosttrade = await runFirstCycleCloseVerify({
    exchange: args.exchange,
    symbol: args.symbol,
    hours: 24,
  });

  const output = {
    ok: buyVerify.ok === true
      && lifecycleTrace.ok === true
      && closeVerifyAfterPosttrade.ok === true
      && posttradeVerify.ok === true
      && reflexionVerify.ok === true
      && reflexionVerify.avoidanceSimulation?.matched === true,
    phase: 'Z2_Z7',
    safety: {
      paperOnly: true,
      liveOrders: false,
      maxUsdt: args.maxUsdt,
      symbol: args.symbol,
      exchange: args.exchange,
      tradeMode,
    },
    ids: {
      runId,
      buySignalId,
      sellSignalId,
      buyTradeId,
      sellTradeId,
    },
    buyVerify,
    lifecycleTrace,
    closeVerifyBeforePosttrade,
    posttradeWorker,
    posttradeVerify,
    reflexionVerify,
    closeVerifyAfterPosttrade,
  };
  if (args.cleanup) {
    output.cleanup = await cleanupFirstCloseCycleArtifacts({
      symbol: args.symbol,
      exchange: args.exchange,
      tradeMode,
      buyTradeId,
      sellTradeId,
      buySignalId,
      sellSignalId,
      knowledgeIds: [
        posttradeWorker?.learning?.dashboardRecord?.knowledgeId,
      ],
    });
  }
  return output;
}

async function main() {
  const args = parseArgs();
  const result = await runFirstCloseCycleDrill(args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`first close cycle drill ${result.ok ? 'ok' : 'needs_attention'} — buy=${result.ids.buyTradeId} sell=${result.ids.sellTradeId}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-first-close-cycle-drill 실패:',
  });
}
