#!/usr/bin/env node
// @ts-nocheck
/**
 * runtime-first-buy-cycle-verify.ts — Phase Z2: 첫 BUY 사이클 추적 검증
 *
 * 마지막 BUY 1건을 추적:
 *   signal_id → trade_id → position_id → lifecycle stages
 *
 * 사용법:
 *   tsx bots/investment/scripts/runtime-first-buy-cycle-verify.ts
 *   tsx bots/investment/scripts/runtime-first-buy-cycle-verify.ts --json
 *   tsx bots/investment/scripts/runtime-first-buy-cycle-verify.ts --trade-id=123
 */

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
    exchange: argv.find((a) => a.startsWith('--exchange='))?.split('=')[1] || 'binance',
    tradeId: argv.find((a) => a.startsWith('--trade-id='))
      ? Number(argv.find((a) => a.startsWith('--trade-id='))!.split('=')[1])
      : null,
    hours: Number(argv.find((a) => a.startsWith('--hours='))?.split('=')[1] || 72),
  };
}

async function getLastBuyTrade(exchange: string, hours: number, tradeId: number | null) {
  try {
    if (tradeId) {
      return await db.get(
        `SELECT id, signal_id, symbol, side, amount, price, total_usdt,
                paper, exchange, trade_mode, executed_at, tp_price, sl_price,
                tp_sl_set, execution_origin, quality_flag
           FROM trades
          WHERE id = $1`,
        [tradeId],
      );
    }
    return await db.get(
      `SELECT id, signal_id, symbol, side, amount, price, total_usdt,
              paper, exchange, trade_mode, executed_at, tp_price, sl_price,
              tp_sl_set, execution_origin, quality_flag
         FROM trades
        WHERE side = 'buy'
          AND exchange = $1
          AND executed_at >= NOW() - INTERVAL '${Math.max(1, hours)} hours'
        ORDER BY executed_at DESC
        LIMIT 1`,
      [exchange],
    );
  } catch {
    return null;
  }
}

async function getSignalForTrade(signalId: number | null) {
  if (!signalId) return null;
  try {
    return await db.get(
      `SELECT id, symbol, action, status, confidence, reasoning,
              exchange, trade_mode, nemesis_verdict, approved_at,
              strategy_family, strategy_quality, created_at
         FROM signals
        WHERE id = $1`,
      [signalId],
    );
  } catch {
    return null;
  }
}

async function getPositionForSymbol(symbol: string, exchange: string) {
  try {
    return await db.get(
      `SELECT id, symbol, amount, avg_price, unrealized_pnl,
              exchange, paper, trade_mode, created_at, updated_at
         FROM positions
        WHERE symbol = $1
          AND exchange = $2
        ORDER BY updated_at DESC
        LIMIT 1`,
      [symbol, exchange],
    );
  } catch {
    return null;
  }
}

async function getLifecycleEvents(symbol: string, exchange: string) {
  try {
    const scopeKey = `${exchange}:${symbol}`;
    const rows = await db.query(
      `SELECT id, position_scope_key, phase, stage_id, owner_agent,
              event_type, created_at, input_snapshot, output_snapshot
         FROM investment.position_lifecycle_events
        WHERE position_scope_key ILIKE $1
           OR (symbol = $2 AND exchange = $3)
        ORDER BY created_at ASC
        LIMIT 100`,
      [`%${symbol}%`, symbol, exchange],
    );
    return rows || [];
  } catch {
    return [];
  }
}

async function getSignalExecutionTrace(signalId: number | null) {
  if (!signalId) return null;
  try {
    const rows = await db.query(
      `SELECT event_type, payload, created_at
         FROM investment.mapek_knowledge
        WHERE payload->>'signal_id' = $1
           OR payload->>'trade_id' IN (
             SELECT id::text FROM trades WHERE signal_id = $1 LIMIT 5
           )
        ORDER BY created_at ASC
        LIMIT 20`,
      [String(signalId)],
    );
    return rows || [];
  } catch {
    return [];
  }
}

const STAGE_LABELS: Record<string, string> = {
  stage_1: 'Stage 1: Entry',
  stage_2: 'Stage 2: Established',
  stage_3: 'Stage 3: Monitoring',
  stage_4: 'Stage 4: Mature',
  stage_5: 'Stage 5: Decision',
  stage_6: 'Stage 6: Exit Plan',
  stage_7: 'Stage 7: Closure',
  stage_8: 'Stage 8: Cleanup',
};

function summarizeLifecycle(events: any[]) {
  const stages: Record<string, { eventCount: number; lastEvent: string; lastAt: string }> = {};
  const phases: Record<string, number> = {};
  for (const evt of events) {
    const stageId = evt.stage_id || 'unknown';
    if (!stages[stageId]) stages[stageId] = { eventCount: 0, lastEvent: '', lastAt: '' };
    stages[stageId].eventCount++;
    stages[stageId].lastEvent = evt.event_type;
    stages[stageId].lastAt = evt.created_at;
    const phase = evt.phase || 'unknown';
    phases[phase] = (phases[phase] || 0) + 1;
  }
  const reachedStages = Object.keys(stages).filter((s) => s.startsWith('stage_'));
  const maxStage = reachedStages.length > 0
    ? reachedStages.sort((a, b) => Number(a.split('_')[1]) - Number(b.split('_')[1])).at(-1)
    : null;
  return { stages, phases, reachedStages, maxStage };
}

function checkDof(trade: any, position: any, lifecycleEvents: any[], signal: any): string[] {
  const dof: string[] = [];
  if (trade) dof.push('✅ trades 1건 BUY 기록');
  else dof.push('❌ trades BUY 기록 없음');
  if (signal) dof.push(`✅ signal 매칭 (id=${signal.id}, confidence=${signal.confidence})`);
  else if (trade?.signal_id) dof.push('⚠️  signal 조회 실패');
  else dof.push('⚠️  signal_id 없음');
  if (position) dof.push(`✅ positions 1건 active (amount=${position.amount})`);
  else dof.push('⚠️  positions active 기록 없음 (이미 closed 이거나 미생성)');
  const stageNums = lifecycleEvents
    .map((e) => Number((e.stage_id || '').split('_')[1]))
    .filter(Number.isFinite);
  const maxStage = stageNums.length > 0 ? Math.max(...stageNums) : 0;
  if (maxStage >= 1) dof.push(`✅ lifecycle Stage ${maxStage} 도달 (총 ${lifecycleEvents.length}건)`);
  else dof.push('⚠️  lifecycle 이벤트 없음');
  if (trade?.tp_sl_set) dof.push('✅ TP/SL 설정 완료');
  else dof.push('⚠️  TP/SL 미설정');
  return dof;
}

export async function runFirstBuyCycleVerify({
  exchange = 'binance',
  hours = 72,
  tradeId = null,
}: { exchange?: string; hours?: number; tradeId?: number | null } = {}) {
  await db.initSchema();

  const trade = await getLastBuyTrade(exchange, hours, tradeId);
  const signal = trade?.signal_id ? await getSignalForTrade(trade.signal_id) : null;
  const position = trade?.symbol ? await getPositionForSymbol(trade.symbol, exchange) : null;
  const lifecycleEvents = trade?.symbol ? await getLifecycleEvents(trade.symbol, exchange) : [];
  const lifecycleSummary = summarizeLifecycle(lifecycleEvents);
  const traceEvents = trade?.signal_id ? await getSignalExecutionTrace(trade.signal_id) : [];
  const dof = checkDof(trade, position, lifecycleEvents, signal);

  return {
    ok: trade != null,
    checkedAt: new Date().toISOString(),
    exchange,
    dof,
    trade: trade ? {
      id: trade.id,
      signalId: trade.signal_id,
      symbol: trade.symbol,
      side: trade.side,
      amount: trade.amount,
      price: trade.price,
      totalUsdt: trade.total_usdt,
      paper: trade.paper,
      tpSlSet: trade.tp_sl_set,
      tradeMode: trade.trade_mode,
      executedAt: trade.executed_at,
      executionOrigin: trade.execution_origin,
    } : null,
    signal: signal ? {
      id: signal.id,
      symbol: signal.symbol,
      action: signal.action,
      status: signal.status,
      confidence: signal.confidence,
      strategyFamily: signal.strategy_family,
      approvedAt: signal.approved_at,
      createdAt: signal.created_at,
    } : null,
    position: position ? {
      symbol: position.symbol,
      amount: position.amount,
      avgPrice: position.avg_price,
      unrealizedPnl: position.unrealized_pnl,
      paper: position.paper,
      tradeMode: position.trade_mode,
      updatedAt: position.updated_at,
    } : null,
    lifecycle: {
      totalEvents: lifecycleEvents.length,
      maxStage: lifecycleSummary.maxStage,
      reachedStages: lifecycleSummary.reachedStages,
      stages: lifecycleSummary.stages,
      recentEvents: lifecycleEvents.slice(-5).map((e) => ({
        phase: e.phase,
        stageId: e.stage_id,
        eventType: e.event_type,
        at: e.created_at,
      })),
    },
    traceEvents: (traceEvents || []).map((e) => ({
      eventType: e.event_type,
      at: e.created_at,
      payloadSummary: Object.keys(e.payload || {}).slice(0, 5),
    })),
  };
}

async function main() {
  const args = parseArgs();
  const result = await runFirstBuyCycleVerify({
    exchange: args.exchange,
    hours: args.hours,
    tradeId: args.tradeId,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('');
  console.log('📊 Phase Z2: 첫 BUY 사이클 검증');
  console.log('='.repeat(50));
  console.log(`checkedAt: ${result.checkedAt} / exchange: ${result.exchange}`);
  console.log('');

  if (!result.trade) {
    console.log('⚠️  최근 BUY 거래 없음');
    console.log(`   (검색 범위: 최근 ${args.hours}h / exchange=${args.exchange})`);
    console.log('   Phase Z1 진단 도구로 시그널 차단 원인 확인 필요');
    console.log('');
    return;
  }

  console.log('💰 BUY 거래');
  console.log(`  trade_id: ${result.trade.id}`);
  console.log(`  signal_id: ${result.trade.signalId ?? 'n/a'}`);
  console.log(`  symbol: ${result.trade.symbol} / side: ${result.trade.side}`);
  console.log(`  amount: ${result.trade.amount} @ ${result.trade.price} USDT`);
  console.log(`  paper: ${result.trade.paper} / tpSlSet: ${result.trade.tpSlSet}`);
  console.log(`  executedAt: ${result.trade.executedAt}`);

  if (result.signal) {
    console.log('');
    console.log('🎯 시그널');
    console.log(`  signal_id: ${result.signal.id} / action: ${result.signal.action}`);
    console.log(`  confidence: ${result.signal.confidence} / status: ${result.signal.status}`);
    console.log(`  strategy: ${result.signal.strategyFamily ?? 'n/a'}`);
  }

  if (result.position) {
    console.log('');
    console.log('📍 포지션');
    console.log(`  symbol: ${result.position.symbol} / amount: ${result.position.amount}`);
    console.log(`  avgPrice: ${result.position.avgPrice}`);
    console.log(`  unrealizedPnl: ${result.position.unrealizedPnl}`);
    console.log(`  paper: ${result.position.paper}`);
  }

  console.log('');
  console.log('🔄 Lifecycle 진행');
  console.log(`  총 이벤트: ${result.lifecycle.totalEvents}건`);
  console.log(`  최대 Stage: ${result.lifecycle.maxStage ? STAGE_LABELS[result.lifecycle.maxStage] || result.lifecycle.maxStage : '없음'}`);
  console.log(`  도달 stages: ${result.lifecycle.reachedStages.join(', ') || '없음'}`);
  if (result.lifecycle.recentEvents.length > 0) {
    console.log('  최근 이벤트:');
    for (const e of result.lifecycle.recentEvents) {
      console.log(`    [${e.phase}] ${e.stageId || 'n/a'} → ${e.eventType} @ ${e.at}`);
    }
  }

  console.log('');
  console.log('✅ Definition of Done');
  for (const line of result.dof) {
    console.log(`  ${line}`);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-first-buy-cycle-verify 실패:',
  });
}
