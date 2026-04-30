#!/usr/bin/env node
// @ts-nocheck
/**
 * runtime-first-cycle-close-verify.ts — Phase Z4: SELL + close 이벤트 검증 (핵심)
 *
 * SELL → close 이벤트 → posttrade trigger 추적:
 *   trades(SELL) → positions(closed) → lifecycle Stage 7 → event-lake → posttrade trigger
 *
 * 사용법:
 *   tsx bots/investment/scripts/runtime-first-cycle-close-verify.ts
 *   tsx bots/investment/scripts/runtime-first-cycle-close-verify.ts --json
 *   tsx bots/investment/scripts/runtime-first-cycle-close-verify.ts --symbol=BTC/USDT
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVESTMENT_DIR = path.resolve(__dirname, '..');
const POSTTRADE_HEARTBEAT = path.join(INVESTMENT_DIR, 'output', 'ops', 'posttrade-feedback-worker-heartbeat.json');

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
    exchange: argv.find((a) => a.startsWith('--exchange='))?.split('=')[1] || 'binance',
    symbol: argv.find((a) => a.startsWith('--symbol='))?.split('=')[1] || null,
    hours: Number(argv.find((a) => a.startsWith('--hours='))?.split('=')[1] || 168),
  };
}

function readJson(file: string) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function heartbeatAgeMinutes(hb: any) {
  const ts = hb?.completedAt || hb?.startedAt;
  if (!ts) return null;
  return Math.round((Date.now() - new Date(ts).getTime()) / 60000);
}

async function getLastSellTrade(exchange: string, symbol: string | null, hours: number) {
  try {
    const cond = symbol ? `AND symbol = '${symbol}'` : '';
    return await db.get(
      `SELECT id, signal_id, symbol, side, amount, price, total_usdt,
              paper, exchange, trade_mode, executed_at, execution_origin
         FROM trades
        WHERE side = 'sell'
          AND exchange = $1
          AND executed_at >= NOW() - INTERVAL '${Math.max(1, hours)} hours'
          ${cond}
        ORDER BY executed_at DESC
        LIMIT 1`,
      [exchange],
    );
  } catch {
    return null;
  }
}

async function getMatchingBuyTrade(symbol: string, sellTrade: any) {
  if (!symbol || !sellTrade) return null;
  try {
    return await db.get(
      `SELECT id, signal_id, symbol, side, amount, price, total_usdt,
              paper, executed_at
         FROM trades
        WHERE side = 'buy'
          AND symbol = $1
          AND executed_at < $2
        ORDER BY executed_at DESC
        LIMIT 1`,
      [symbol, sellTrade.executed_at],
    );
  } catch {
    return null;
  }
}

async function getPositionClosed(symbol: string, exchange: string) {
  try {
    const current = await db.get(
      `SELECT id, symbol, amount, avg_price, exchange, paper, trade_mode, updated_at
         FROM positions
        WHERE symbol = $1 AND exchange = $2
        ORDER BY updated_at DESC LIMIT 1`,
      [symbol, exchange],
    );
    return {
      current,
      isClosed: !current || Number(current.amount || 0) === 0,
    };
  } catch {
    return { current: null, isClosed: false };
  }
}

async function getLifecycleClosure(symbol: string, hours: number) {
  try {
    const rows = await db.query(
      `SELECT id, phase, stage_id, event_type, owner_agent, created_at, output_snapshot
         FROM investment.position_lifecycle_events
        WHERE (symbol = $1 OR position_scope_key ILIKE '%' || $1 || '%')
          AND stage_id IN ('stage_6', 'stage_7', 'stage_8')
          AND created_at >= NOW() - INTERVAL '${Math.max(1, hours)} hours'
        ORDER BY created_at ASC`,
      [symbol],
    );
    return rows || [];
  } catch {
    return [];
  }
}

async function getCloseEvents(symbol: string, hours: number) {
  try {
    const rows = await db.query(
      `SELECT event_type, payload, created_at
         FROM investment.mapek_knowledge
        WHERE event_type IN (
          'position_closed', 'close_event', 'phase6_closeout',
          'quality_evaluation_pending', 'closeout_completed',
          'lifecycle_closeout', 'trade_closed'
        )
          AND (payload->>'symbol' = $1 OR payload::text ILIKE '%' || $1 || '%')
          AND created_at >= NOW() - INTERVAL '${Math.max(1, hours)} hours'
        ORDER BY created_at DESC
        LIMIT 20`,
      [symbol],
    );
    return rows || [];
  } catch {
    return [];
  }
}

async function getCloseoutReview(symbol: string, hours: number) {
  try {
    const row = await db.get(
      `SELECT id, symbol, closeout_type, closeout_reason,
              planned_ratio, executed_ratio, pnl_realized,
              review_status, review_result, created_at
         FROM investment.closeout_reviews
        WHERE symbol = $1
          AND created_at >= NOW() - INTERVAL '${Math.max(1, hours)} hours'
        ORDER BY created_at DESC
        LIMIT 1`,
      [symbol],
    );
    return row || null;
  } catch {
    return null;
  }
}

async function getPendingPosttradeEvents(symbol: string) {
  try {
    const rows = await db.query(
      `SELECT id, event_type, payload, created_at, processed_at
         FROM investment.mapek_knowledge
        WHERE event_type = 'quality_evaluation_pending'
          AND processed_at IS NULL
          AND (payload->>'symbol' = $1 OR payload::text ILIKE '%' || $1 || '%')
        ORDER BY created_at DESC
        LIMIT 5`,
      [symbol],
    );
    return rows || [];
  } catch {
    return [];
  }
}

function computePnl(buyTrade: any, sellTrade: any) {
  if (!buyTrade || !sellTrade) return null;
  const buyPrice = Number(buyTrade.price || 0);
  const sellPrice = Number(sellTrade.price || 0);
  const amount = Number(sellTrade.amount || buyTrade.amount || 0);
  if (buyPrice <= 0 || sellPrice <= 0 || amount <= 0) return null;
  const pnlUsdt = (sellPrice - buyPrice) * amount;
  const pnlPct = ((sellPrice - buyPrice) / buyPrice) * 100;
  return { pnlUsdt: Math.round(pnlUsdt * 100) / 100, pnlPct: Math.round(pnlPct * 100) / 100 };
}

function checkDof(
  buyTrade: any,
  sellTrade: any,
  positionStatus: any,
  closureEvents: any[],
  closeEvents: any[],
  pendingPosttrade: any[],
  posttradeHb: any,
) {
  const dof: string[] = [];
  dof.push(sellTrade
    ? `✅ trades 1건 SELL 기록 (id=${sellTrade.id}, at=${sellTrade.executed_at})`
    : `❌ trades SELL 기록 없음`,
  );
  dof.push(buyTrade
    ? `✅ BUY와 매칭 (trade_id=${buyTrade.id})`
    : `⚠️  매칭 BUY 없음`,
  );
  dof.push(positionStatus.isClosed
    ? `✅ positions 0 또는 amount=0 (closed)`
    : `⚠️  positions 아직 amount > 0 (미close)`,
  );
  const hasStage7 = closureEvents.some((e) => e.stage_id === 'stage_7');
  dof.push(hasStage7
    ? `✅ lifecycle Stage 7 (Closure) 도달`
    : `⚠️  lifecycle Stage 7 미도달 (${closureEvents.length}건 stage_6~8)`,
  );
  const hasCloseEvent = closeEvents.some((e) =>
    ['position_closed', 'close_event', 'quality_evaluation_pending', 'phase6_closeout'].includes(e.event_type),
  );
  dof.push(hasCloseEvent
    ? `✅ close 이벤트 emit (mapek_knowledge 기록)`
    : `⚠️  close 이벤트 없음 (position-closeout-engine 미동작 가능)`,
  );
  dof.push(pendingPosttrade.length > 0
    ? `✅ posttrade worker trigger 대기 중 (${pendingPosttrade.length}건 pending)`
    : posttradeHb?.result?.processed >= 1
      ? `✅ posttrade worker 이미 처리 완료 (processed=${posttradeHb.result.processed})`
      : `⚠️  posttrade trigger 미확인 (quality_evaluation_pending 없음)`,
  );
  return dof;
}

export async function runFirstCycleCloseVerify({
  exchange = 'binance',
  symbol = null,
  hours = 168,
}: { exchange?: string; symbol?: string | null; hours?: number } = {}) {
  await db.initSchema();

  const posttradeHb = readJson(POSTTRADE_HEARTBEAT);
  const hbAge = heartbeatAgeMinutes(posttradeHb);

  const sellTrade = await getLastSellTrade(exchange, symbol, hours);
  const resolvedSymbol = symbol || sellTrade?.symbol || null;

  if (!resolvedSymbol && !sellTrade) {
    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      error: 'SELL 거래 없음 — Phase Z4 아직 미도달. Phase Z2(BUY) 먼저 완료 필요',
      posttradeHeartbeat: { ageMinutes: hbAge, processed: posttradeHb?.result?.processed ?? 0 },
    };
  }

  const sym = resolvedSymbol || sellTrade?.symbol!;
  const [buyTrade, positionStatus, closureEvents, closeEvents, pendingPosttrade] = await Promise.allSettled([
    getMatchingBuyTrade(sym, sellTrade),
    getPositionClosed(sym, exchange),
    getLifecycleClosure(sym, hours),
    getCloseEvents(sym, hours),
    getPendingPosttradeEvents(sym),
  ]).then((results) => results.map((r) => (r.status === 'fulfilled' ? r.value : null)));

  const closeoutReview = await getCloseoutReview(sym, hours).catch(() => null);
  const pnl = computePnl(buyTrade, sellTrade);
  const dof = checkDof(
    buyTrade, sellTrade,
    positionStatus || { isClosed: false },
    closureEvents || [],
    closeEvents || [],
    pendingPosttrade || [],
    posttradeHb,
  );

  const hasStage7 = (closureEvents || []).some((e) => e.stage_id === 'stage_7');
  const hasCloseEvent = (closeEvents || []).some((e) =>
    ['position_closed', 'close_event', 'quality_evaluation_pending', 'phase6_closeout'].includes(e.event_type),
  );

  return {
    ok: !!sellTrade && (positionStatus?.isClosed || false) && hasStage7,
    checkedAt: new Date().toISOString(),
    exchange,
    symbol: sym,
    dof,
    pnl,
    sellTrade: sellTrade ? {
      id: sellTrade.id,
      signalId: sellTrade.signal_id,
      symbol: sellTrade.symbol,
      side: sellTrade.side,
      amount: sellTrade.amount,
      price: sellTrade.price,
      paper: sellTrade.paper,
      executedAt: sellTrade.executed_at,
    } : null,
    buyTrade: buyTrade ? {
      id: (buyTrade as any).id,
      amount: (buyTrade as any).amount,
      price: (buyTrade as any).price,
      executedAt: (buyTrade as any).executed_at,
    } : null,
    position: {
      isClosed: (positionStatus as any)?.isClosed ?? false,
      currentAmount: (positionStatus as any)?.current?.amount ?? null,
    },
    lifecycle: {
      closureEventCount: (closureEvents || []).length,
      hasStage7,
      hasStage8: (closureEvents || []).some((e: any) => e.stage_id === 'stage_8'),
      events: (closureEvents || []).map((e: any) => ({
        phase: e.phase,
        stageId: e.stage_id,
        eventType: e.event_type,
        at: e.created_at,
      })),
    },
    closeEvents: {
      total: (closeEvents || []).length,
      hasCloseEvent,
      types: [...new Set((closeEvents || []).map((e: any) => e.event_type))],
      recent: (closeEvents || []).slice(0, 3).map((e: any) => ({
        eventType: e.event_type,
        at: e.created_at,
      })),
    },
    closeoutReview: closeoutReview ? {
      type: (closeoutReview as any).closeout_type,
      reason: (closeoutReview as any).closeout_reason,
      executedRatio: (closeoutReview as any).executed_ratio,
      pnlRealized: (closeoutReview as any).pnl_realized,
      status: (closeoutReview as any).review_status,
    } : null,
    posttradeWorker: {
      ageMinutes: hbAge,
      processed: posttradeHb?.result?.processed ?? 0,
      pendingCount: (pendingPosttrade || []).length,
      heartbeatOk: posttradeHb?.ok === true,
    },
  };
}

async function main() {
  const args = parseArgs();
  const result = await runFirstCycleCloseVerify({
    exchange: args.exchange,
    symbol: args.symbol,
    hours: args.hours,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('');
  console.log('🔒 Phase Z4: SELL + Close 이벤트 검증 ⭐');
  console.log('='.repeat(50));
  console.log(`checkedAt: ${result.checkedAt}`);

  if ((result as any).error) {
    console.log(`⚠️  ${(result as any).error}`);
    const hb = result.posttradeHeartbeat;
    if (hb) console.log(`posttrade heartbeat: age=${hb.ageMinutes}m / processed=${hb.processed}`);
    return;
  }

  console.log(`symbol: ${result.symbol} / exchange: ${result.exchange}`);
  if (result.pnl) {
    const sign = result.pnl.pnlUsdt >= 0 ? '+' : '';
    console.log(`PnL: ${sign}${result.pnl.pnlUsdt} USDT (${sign}${result.pnl.pnlPct}%)`);
  }
  console.log('');

  if (result.sellTrade) {
    console.log('💸 SELL 거래');
    console.log(`  trade_id: ${result.sellTrade.id}`);
    console.log(`  ${result.sellTrade.symbol} / amount: ${result.sellTrade.amount} @ ${result.sellTrade.price}`);
    console.log(`  paper: ${result.sellTrade.paper} / executedAt: ${result.sellTrade.executedAt}`);
  }

  if (result.buyTrade) {
    console.log('');
    console.log('💰 매칭 BUY');
    console.log(`  trade_id: ${result.buyTrade.id} / amount: ${result.buyTrade.amount} @ ${result.buyTrade.price}`);
  }

  console.log('');
  console.log('📍 포지션 상태');
  console.log(`  isClosed: ${result.position.isClosed} / currentAmount: ${result.position.currentAmount ?? 'n/a'}`);

  console.log('');
  console.log('🔄 Lifecycle Closure');
  console.log(`  이벤트: ${result.lifecycle.closureEventCount}건`);
  console.log(`  Stage 7 도달: ${result.lifecycle.hasStage7 ? '✅' : '❌'}`);
  console.log(`  Stage 8 도달: ${result.lifecycle.hasStage8 ? '✅' : '⬜'}`);
  for (const e of result.lifecycle.events) {
    console.log(`  [${e.phase}] ${e.stageId} → ${e.eventType} @ ${e.at}`);
  }

  console.log('');
  console.log('📡 Close 이벤트 (mapek_knowledge)');
  console.log(`  총: ${result.closeEvents.total}건 / hasCloseEvent: ${result.closeEvents.hasCloseEvent ? '✅' : '❌'}`);
  console.log(`  types: ${result.closeEvents.types.join(', ') || '없음'}`);
  for (const e of result.closeEvents.recent) {
    console.log(`  [${e.eventType}] @ ${e.at}`);
  }

  if (result.closeoutReview) {
    console.log('');
    console.log('📋 Closeout Review');
    const r = result.closeoutReview;
    console.log(`  type=${r.type} / reason=${r.reason}`);
    console.log(`  executedRatio=${r.executedRatio} / pnlRealized=${r.pnlRealized}`);
    console.log(`  status=${r.status}`);
  }

  console.log('');
  console.log('🤖 Posttrade Worker');
  const pw = result.posttradeWorker;
  console.log(`  heartbeat: ${pw.heartbeatOk ? '✅' : '❌'} / age=${pw.ageMinutes}m`);
  console.log(`  processed: ${pw.processed} / pending close events: ${pw.pendingCount}`);

  console.log('');
  console.log('✅ Definition of Done');
  for (const line of result.dof) {
    console.log(`  ${line}`);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-first-cycle-close-verify 실패:',
  });
}
