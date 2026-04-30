#!/usr/bin/env node
// @ts-nocheck
/**
 * runtime-first-cycle-lifecycle-trace.ts — Phase Z3: 포지션 Lifecycle 전체 Stage 추적
 *
 * 포지션의 lifecycle 전체 stage 추적:
 *   Stage 1(Entry) → Stage 2(Established) → ... → Stage 8(Cleanup)
 * + Strategy Validity 6-차원 drift 측정 출력
 *
 * 사용법:
 *   tsx bots/investment/scripts/runtime-first-cycle-lifecycle-trace.ts
 *   tsx bots/investment/scripts/runtime-first-cycle-lifecycle-trace.ts --json
 *   tsx bots/investment/scripts/runtime-first-cycle-lifecycle-trace.ts --symbol=BTC/USDT
 */

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
    exchange: argv.find((a) => a.startsWith('--exchange='))?.split('=')[1] || 'binance',
    symbol: argv.find((a) => a.startsWith('--symbol='))?.split('=')[1] || null,
    hours: Number(argv.find((a) => a.startsWith('--hours='))?.split('=')[1] || 168),
  };
}

const STAGE_LABELS: Record<string, string> = {
  stage_1: 'Stage 1: Entry (discovery_collect)',
  stage_2: 'Stage 2: Established (entry_approved)',
  stage_3: 'Stage 3: Monitoring (position_monitoring)',
  stage_4: 'Stage 4: Mature (position_mature)',
  stage_5: 'Stage 5: Decision (exit_decision)',
  stage_6: 'Stage 6: Exit Plan (exit_planned)',
  stage_7: 'Stage 7: Closure (feedback_evaluation)',
  stage_8: 'Stage 8: Cleanup (feedback_learning)',
};

const PHASE_LABELS: Record<string, string> = {
  phase1_collect: 'Phase 1: Collect',
  phase2_analyze: 'Phase 2: Analyze',
  phase3_approve: 'Phase 3: Approve',
  phase4_execute: 'Phase 4: Execute',
  phase5_monitor: 'Phase 5: Monitor',
  phase6_closeout: 'Phase 6: Closeout',
};

async function findActivePosition(exchange: string, symbol: string | null) {
  try {
    if (symbol) {
      return await db.get(
        `SELECT id, symbol, amount, avg_price, unrealized_pnl,
                exchange, paper, trade_mode, created_at, updated_at
           FROM positions
          WHERE symbol = $1 AND exchange = $2
          ORDER BY updated_at DESC LIMIT 1`,
        [symbol, exchange],
      );
    }
    return await db.get(
      `SELECT id, symbol, amount, avg_price, unrealized_pnl,
              exchange, paper, trade_mode, created_at, updated_at
         FROM positions
        WHERE exchange = $1
          AND amount > 0
        ORDER BY updated_at DESC LIMIT 1`,
      [exchange],
    );
  } catch {
    return null;
  }
}

async function getLifecycleEventsForSymbol(symbol: string, exchange: string, hours: number) {
  try {
    const rows = await db.query(
      `SELECT id, position_scope_key, exchange, symbol, trade_mode,
              phase, stage_id, owner_agent, event_type,
              input_snapshot, output_snapshot, policy_snapshot, evidence_snapshot,
              created_at
         FROM investment.position_lifecycle_events
        WHERE (symbol = $1 OR position_scope_key ILIKE '%' || $1 || '%')
          AND created_at >= NOW() - INTERVAL '${Math.max(1, hours)} hours'
        ORDER BY created_at ASC
        LIMIT 200`,
      [symbol],
    );
    return rows || [];
  } catch {
    return [];
  }
}

async function getStrategyValidityChecks(symbol: string, hours: number) {
  try {
    const rows = await db.query(
      `SELECT event_type, payload, created_at
         FROM investment.mapek_knowledge
        WHERE event_type IN (
          'strategy_validity_check', 'strategy_validity_drift',
          'position_validity_score', 'validity_evaluation'
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

async function getCloseoutReviews(symbol: string) {
  try {
    const rows = await db.query(
      `SELECT id, symbol, exchange, closeout_type, closeout_reason,
              planned_ratio, executed_ratio, pnl_realized,
              review_status, review_result, created_at
         FROM investment.closeout_reviews
        WHERE symbol = $1
        ORDER BY created_at DESC
        LIMIT 10`,
      [symbol],
    );
    return rows || [];
  } catch {
    return [];
  }
}

async function getRecentMapekEvents(symbol: string, hours: number) {
  try {
    const rows = await db.query(
      `SELECT event_type, payload, created_at
         FROM investment.mapek_knowledge
        WHERE (payload->>'symbol' = $1 OR payload::text ILIKE '%' || $1 || '%')
          AND created_at >= NOW() - INTERVAL '${Math.max(1, hours)} hours'
          AND event_type NOT IN ('quality_evaluation_pending')
        ORDER BY created_at DESC
        LIMIT 30`,
      [symbol],
    );
    return rows || [];
  } catch {
    return [];
  }
}

function buildStageTimeline(events: any[]) {
  const timeline: Record<string, {
    firstAt: string;
    lastAt: string;
    eventCount: number;
    events: Array<{ eventType: string; phase: string; at: string; ownerAgent: string }>;
  }> = {};

  for (const evt of events) {
    const stageId = evt.stage_id || 'unknown';
    if (!timeline[stageId]) {
      timeline[stageId] = { firstAt: evt.created_at, lastAt: evt.created_at, eventCount: 0, events: [] };
    }
    const entry = timeline[stageId];
    entry.lastAt = evt.created_at;
    entry.eventCount++;
    entry.events.push({
      eventType: evt.event_type,
      phase: evt.phase || '',
      at: evt.created_at,
      ownerAgent: evt.owner_agent || '',
    });
  }

  return timeline;
}

function computeStageDurationMinutes(timeline: any, stageId: string) {
  const entry = timeline[stageId];
  if (!entry) return null;
  return Math.round((new Date(entry.lastAt).getTime() - new Date(entry.firstAt).getTime()) / 60000);
}

function checkLifecycleDof(events: any[], position: any, closeoutReviews: any[]) {
  const stageNums = events
    .map((e) => Number((e.stage_id || '').replace('stage_', '')))
    .filter(Number.isFinite);
  const maxStage = stageNums.length > 0 ? Math.max(...stageNums) : 0;
  const dof: string[] = [];

  dof.push(maxStage >= 1 ? `✅ Stage 1 (Entry) 도달` : `❌ Stage 1 (Entry) 미도달`);
  dof.push(maxStage >= 2 ? `✅ Stage 2 (Established) 도달` : `⚠️  Stage 2 미도달`);
  dof.push(maxStage >= 3 ? `✅ Stage 3 (Monitoring) 도달` : `⚠️  Stage 3 미도달`);
  dof.push(maxStage >= 4 ? `✅ Stage 4 (Mature) 도달` : `⚠️  Stage 4 미도달`);

  const hasPhase5 = events.some((e) => e.phase === 'phase5_monitor');
  dof.push(hasPhase5 ? `✅ Phase 5 Monitor 이벤트 확인` : `⚠️  Phase 5 Monitor 이벤트 없음`);

  const hasStrategyValidity = events.some((e) =>
    String(e.event_type || '').includes('validity') || String(e.event_type || '').includes('strategy'),
  );
  dof.push(hasStrategyValidity
    ? `✅ Strategy Validity 평가 이벤트 확인`
    : `⚠️  Strategy Validity 이벤트 없음 (모니터링 미시작 또는 mapek_knowledge 확인 필요)`,
  );

  dof.push(closeoutReviews.length > 0
    ? `✅ closeout_reviews 기록 있음 (${closeoutReviews.length}건)`
    : `⚠️  closeout_reviews 없음 (SELL 전 정상)`,
  );

  return { dof, maxStage };
}

export async function runFirstCycleLifecycleTrace({
  exchange = 'binance',
  symbol = null,
  hours = 168,
}: { exchange?: string; symbol?: string | null; hours?: number } = {}) {
  await db.initSchema();

  const position = await findActivePosition(exchange, symbol);
  const resolvedSymbol = symbol || position?.symbol || null;

  if (!resolvedSymbol) {
    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      error: '추적할 포지션 없음 — --symbol=BTC/USDT 또는 먼저 BUY 실행 필요',
      position: null,
      lifecycle: null,
    };
  }

  const [lifecycleEvents, strategyChecks, closeoutReviews, mapekEvents] = await Promise.allSettled([
    getLifecycleEventsForSymbol(resolvedSymbol, exchange, hours),
    getStrategyValidityChecks(resolvedSymbol, hours),
    getCloseoutReviews(resolvedSymbol),
    getRecentMapekEvents(resolvedSymbol, hours),
  ]).then((results) => results.map((r) => (r.status === 'fulfilled' ? r.value : [])));

  const timeline = buildStageTimeline(lifecycleEvents || []);
  const { dof, maxStage } = checkLifecycleDof(lifecycleEvents || [], position, closeoutReviews || []);

  const allStageIds = Object.keys(STAGE_LABELS);
  const stageProgress = allStageIds.map((sid) => ({
    stageId: sid,
    label: STAGE_LABELS[sid],
    reached: !!timeline[sid],
    firstAt: timeline[sid]?.firstAt ?? null,
    eventCount: timeline[sid]?.eventCount ?? 0,
    durationMinutes: computeStageDurationMinutes(timeline, sid),
  }));

  return {
    ok: maxStage >= 3,
    checkedAt: new Date().toISOString(),
    exchange,
    symbol: resolvedSymbol,
    maxStage,
    dof,
    position: position ? {
      symbol: position.symbol,
      amount: position.amount,
      avgPrice: position.avg_price,
      unrealizedPnl: position.unrealized_pnl,
      paper: position.paper,
      updatedAt: position.updated_at,
    } : null,
    lifecycle: {
      totalEvents: (lifecycleEvents || []).length,
      stageProgress,
      recentEvents: (lifecycleEvents || []).slice(-10).map((e) => ({
        phase: e.phase,
        stageId: e.stage_id,
        eventType: e.event_type,
        ownerAgent: e.owner_agent,
        at: e.created_at,
      })),
    },
    strategyValidity: {
      checkCount: (strategyChecks || []).length,
      recent: (strategyChecks || []).slice(0, 5).map((e) => ({
        eventType: e.event_type,
        at: e.created_at,
        score: e.payload?.score ?? e.payload?.validity_score ?? null,
        action: e.payload?.action ?? null,
      })),
    },
    closeoutReviews: (closeoutReviews || []).map((r) => ({
      id: r.id,
      type: r.closeout_type,
      reason: r.closeout_reason,
      executedRatio: r.executed_ratio,
      pnlRealized: r.pnl_realized,
      status: r.review_status,
      at: r.created_at,
    })),
    mapekEventTypes: [...new Set((mapekEvents || []).map((e) => e.event_type))],
  };
}

async function main() {
  const args = parseArgs();
  const result = await runFirstCycleLifecycleTrace({
    exchange: args.exchange,
    symbol: args.symbol,
    hours: args.hours,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('');
  console.log('🔄 Phase Z3: Lifecycle Stage 추적');
  console.log('='.repeat(50));
  console.log(`checkedAt: ${result.checkedAt}`);

  if (result.error) {
    console.log(`⚠️  ${result.error}`);
    return;
  }

  console.log(`symbol: ${result.symbol} / exchange: ${result.exchange}`);
  console.log(`maxStage: ${result.maxStage ? STAGE_LABELS[`stage_${result.maxStage}`] || `stage_${result.maxStage}` : '없음'}`);
  console.log('');

  if (result.position) {
    console.log('📍 포지션');
    console.log(`  ${result.position.symbol}: amount=${result.position.amount} @ ${result.position.avgPrice}`);
    console.log(`  PnL: ${result.position.unrealizedPnl} / paper=${result.position.paper}`);
    console.log('');
  }

  console.log('📈 Stage 진행 현황');
  for (const s of result.lifecycle.stageProgress) {
    const icon = s.reached ? '✅' : '⬜';
    const dur = s.durationMinutes != null ? ` (${s.durationMinutes}m)` : '';
    const evts = s.reached ? ` [${s.eventCount}건]` : '';
    console.log(`  ${icon} ${s.label}${evts}${dur}`);
    if (s.reached && s.firstAt) {
      console.log(`      시작: ${new Date(s.firstAt).toLocaleString('ko-KR')}`);
    }
  }
  console.log('');

  console.log('📡 최근 Lifecycle 이벤트');
  for (const e of result.lifecycle.recentEvents.slice(-5)) {
    console.log(`  [${e.phase}] ${e.stageId || 'n/a'} → ${e.eventType} (${e.ownerAgent || 'n/a'}) @ ${e.at}`);
  }
  console.log('');

  if (result.strategyValidity.checkCount > 0) {
    console.log('📊 Strategy Validity 평가');
    console.log(`  총 평가: ${result.strategyValidity.checkCount}건`);
    for (const c of result.strategyValidity.recent) {
      const score = c.score != null ? ` score=${Number(c.score).toFixed(2)}` : '';
      console.log(`  [${c.eventType}]${score} action=${c.action || 'n/a'} @ ${c.at}`);
    }
    console.log('');
  }

  if (result.closeoutReviews.length > 0) {
    console.log('🔒 Closeout Reviews');
    for (const r of result.closeoutReviews) {
      console.log(`  [${r.type}] ${r.reason} / ratio=${r.executedRatio} pnl=${r.pnlRealized}`);
    }
    console.log('');
  }

  console.log('✅ Definition of Done');
  for (const line of result.dof) {
    console.log(`  ${line}`);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-first-cycle-lifecycle-trace 실패:',
  });
}
