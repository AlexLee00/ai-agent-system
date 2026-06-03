// @ts-nocheck
/**
 * unified-entry-guard.ts — S2 C2 통합 중복/포지션 가드 (SHADOW 전용)
 *
 * ★ 실제 주문 경로(executeSignal / entry-trigger-engine)에 절대 연결 금지.
 * ★ 판정은 investment.unified_guard_shadow 테이블에만 기록.
 * ★ UNIFIED_GUARD_SHADOW_ENABLED=true 일 때만 활성화 (기본 false = Kill Switch OFF).
 *
 * 세 방어 기준 통합:
 *   1) checkSafetyGates (signal.ts): 원칙 1~6 (단일포지션·자본·포지션수·일손실·쿨다운·드로우다운)
 *   2) entry-trigger-engine: open_position_reentry + duplicate_fire_cooldown
 *   3) getRecentSignalDuplicate (db/signals.ts): signal 중복 dedup
 *   + race_guard: 동시 실행 근접시각 중복 주문 감지
 */

import { query as dbQuery, run as dbRun } from './db/core.ts';
import { getAllPositions, getTodayPnl } from './db/positions.ts';
import { getLatestEquity, getEquityHistory } from './db/risk.ts';
import { getSignalLimits, hasOpenPositionForSymbol } from './signal.ts';
import { getSignalDedupeWindowMinutes } from './runtime-config.ts';

const ENABLED_ENV = 'UNIFIED_GUARD_SHADOW_ENABLED';

// duplicate_fire_cooldown 기본 쿨다운: entry-trigger-engine의 fireCooldownMinutes 기본값과 동일
const DEFAULT_FIRE_COOLDOWN_MINUTES = 10;
// race guard: 같은 심볼의 근접시각 중복 주문 감지 창 (초)
const RACE_GUARD_SECONDS = 30;

export function isUnifiedGuardShadowEnabled() {
  return process.env[ENABLED_ENV] === 'true';
}

function normalizeSymbol(s = '') {
  return String(s || '').trim().toUpperCase();
}

function calcMaxDrawdown(equityRows = []) {
  if (equityRows.length < 2) return 0;
  let peak = Number(equityRows[0]?.equity || 0);
  let maxDD = 0;
  for (const r of equityRows) {
    const eq = Number(r?.equity || 0);
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? (peak - eq) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

/**
 * 통합 가드 판정 — 실제 차단 없음, 판정 결과만 반환.
 *
 * @param signal  신호 객체 (id, symbol, action, amount_usdt, exchange, trade_mode)
 * @returns  { decision, reason, checks, blockedBy } 또는 null(비활성화 시)
 */
export async function evaluateUnifiedGuard(signal) {
  if (!isUnifiedGuardShadowEnabled()) return null;

  const symbol   = normalizeSymbol(signal.symbol);
  const action   = String(signal.action || '').toUpperCase();
  const exchange = signal.exchange || 'binance';
  const tradeMode = signal.trade_mode || 'normal';
  const orderValue = Number(signal.amount_usdt ?? signal.amountUsdt ?? 0);
  const isBuy = action === 'BUY';
  const INITIAL_EQUITY = 138.71; // signal.ts와 동일한 폴백

  const limits = getSignalLimits(exchange, tradeMode);
  const dedupeWindow = getSignalDedupeWindowMinutes();

  // 필요한 데이터를 병렬 로드 — 부분 실패 허용
  const [
    equityResult,
    positionsResult,
    pnlResult,
    recentTradesResult,
    equityHistoryResult,
    recentSignalResult,
    raceSignalResult,
    recentFiredTriggerResult,
  ] = await Promise.allSettled([
    getLatestEquity(),
    getAllPositions(exchange, false, tradeMode),
    getTodayPnl(exchange),
    dbQuery(
      `SELECT pnl_net, exit_time
         FROM investment.trade_journal
        WHERE status = 'closed'
          AND ($1::text IS NULL OR exchange = $1)
          AND ($2::text IS NULL OR COALESCE(trade_mode, 'normal') = $2)
        ORDER BY exit_time DESC
        LIMIT $3`,
      [exchange || null, tradeMode || null, limits.COOLDOWN_AFTER_LOSS_STREAK],
    ),
    getEquityHistory(200, { positiveOnly: true }),
    // signal 중복 (dedup window)
    dbQuery(
      `SELECT id, created_at FROM signals
        WHERE symbol = $1 AND action = $2 AND exchange = $3
          AND COALESCE(trade_mode, 'normal') = $4
          AND created_at > now() - ($5 * INTERVAL '1 minute')
          AND ($6::text IS NULL OR id != $6)
        ORDER BY created_at DESC LIMIT 1`,
      [symbol, action, exchange, tradeMode, dedupeWindow, signal.id || null],
    ),
    // race guard: 같은 심볼 근접시각 주문
    dbQuery(
      `SELECT id, created_at FROM signals
        WHERE symbol = $1 AND exchange = $2
          AND created_at > now() - ($3 * INTERVAL '1 second')
          AND ($4::text IS NULL OR id != $4)
        ORDER BY created_at DESC LIMIT 1`,
      [symbol, exchange, RACE_GUARD_SECONDS, signal.id || null],
    ),
    // duplicate_fire_cooldown: 최근 fired entry_trigger
    dbQuery(
      `SELECT id, fired_at FROM entry_triggers
        WHERE symbol = $1 AND exchange = $2
          AND trigger_state = 'fired'
          AND fired_at >= now() - ($3 * INTERVAL '1 minute')
        ORDER BY fired_at DESC LIMIT 1`,
      [symbol, exchange, DEFAULT_FIRE_COOLDOWN_MINUTES],
    ),
  ]);

  const settled = (r, fallback) => (r.status === 'fulfilled' ? r.value : fallback);

  const totalAsset   = Number(settled(equityResult, null) ?? INITIAL_EQUITY);
  const positions    = settled(positionsResult, []);
  const pnlData      = settled(pnlResult, { pnl: 0 });
  const pnl          = Number(pnlData?.pnl ?? 0);
  const recentTrades = settled(recentTradesResult, []);
  const equityHistory = settled(equityHistoryResult, []);
  const recentSignals = settled(recentSignalResult, []);
  const raceSignals   = settled(raceSignalResult, []);
  const recentFiredTriggers = settled(recentFiredTriggerResult, []);

  const checks = {};
  const blockedBy = [];

  // ── 원칙 1: 단일 포지션 ≤ MAX_SINGLE_PCT ───────────────────────────
  if (isBuy) {
    const passed = !(orderValue > totalAsset * limits.MAX_SINGLE_PCT);
    checks.rule1_single_position = {
      passed,
      detail: !passed
        ? `orderValue=$${orderValue.toFixed(0)} > limit=$${(totalAsset * limits.MAX_SINGLE_PCT).toFixed(0)}`
        : undefined,
    };
    if (!passed) blockedBy.push('rule1_single_position');
  }

  // ── 원칙 2: 총 자본 사용률 ≤ MAX_CAPITAL_USAGE ──────────────────────
  if (isBuy) {
    const currentExposure = positions.reduce(
      (sum, p) => sum + Number(p.amount || 0) * Number(p.avg_price || 0), 0,
    );
    const projectedExposure = currentExposure + orderValue;
    const passed = !(projectedExposure > totalAsset * limits.MAX_CAPITAL_USAGE);
    checks.rule2_capital_usage = {
      passed,
      detail: !passed
        ? `projected=$${projectedExposure.toFixed(0)} > limit=$${(totalAsset * limits.MAX_CAPITAL_USAGE).toFixed(0)}`
        : undefined,
    };
    if (!passed) blockedBy.push('rule2_capital_usage');
  }

  // ── 원칙 3: 동시 포지션 ≤ MAX_POSITIONS ────────────────────────────
  if (isBuy) {
    const opensNew = !hasOpenPositionForSymbol(positions, symbol);
    const passed = !(opensNew && positions.length >= limits.MAX_POSITIONS);
    checks.rule3_max_positions = {
      passed,
      detail: !passed
        ? `positions=${positions.length} >= max=${limits.MAX_POSITIONS}, opensNew=${opensNew}`
        : undefined,
    };
    if (!passed) blockedBy.push('rule3_max_positions');
  }

  // ── 원칙 4: 일일 손실 ≤ MAX_DAILY_LOSS ─────────────────────────────
  const rule4Passed = !(pnl < -(totalAsset * limits.MAX_DAILY_LOSS));
  checks.rule4_daily_loss = {
    passed: rule4Passed,
    detail: !rule4Passed
      ? `pnl=$${pnl.toFixed(2)} < limit=-$${(totalAsset * limits.MAX_DAILY_LOSS).toFixed(2)}`
      : undefined,
  };
  if (!rule4Passed) blockedBy.push('rule4_daily_loss');

  // ── 원칙 5: 연속 손실 쿨다운 ────────────────────────────────────────
  let rule5Passed = true;
  let rule5Detail;
  if (recentTrades.length >= limits.COOLDOWN_AFTER_LOSS_STREAK) {
    const allLoss = recentTrades.every(r => Number(r.pnl_net || 0) < 0);
    if (allLoss) {
      const lastExitAt = Number(recentTrades[0].exit_time || 0);
      const cooldownEnd = lastExitAt + limits.COOLDOWN_MINUTES * 60 * 1000;
      if (Date.now() < cooldownEnd) {
        rule5Passed = false;
        rule5Detail = `streak=${limits.COOLDOWN_AFTER_LOSS_STREAK}연속손실, 잔여=${Math.ceil((cooldownEnd - Date.now()) / 60000)}분`;
      }
    }
  }
  checks.rule5_loss_cooldown = { passed: rule5Passed, detail: rule5Detail };
  if (!rule5Passed) blockedBy.push('rule5_loss_cooldown');

  // ── 원칙 6: 최대 드로우다운 ≤ MAX_DRAWDOWN ──────────────────────────
  const maxDD = calcMaxDrawdown(equityHistory);
  const rule6Passed = !(maxDD > limits.MAX_DRAWDOWN);
  checks.rule6_drawdown = {
    passed: rule6Passed,
    detail: !rule6Passed
      ? `maxDD=${(maxDD * 100).toFixed(1)}% > limit=${(limits.MAX_DRAWDOWN * 100).toFixed(1)}%`
      : undefined,
  };
  if (!rule6Passed) blockedBy.push('rule6_drawdown');

  // ── 오픈 포지션 재진입 방어 (entry-trigger-engine 계열) ─────────────
  if (isBuy) {
    const openSymbols = new Set(
      positions
        .filter(p => Number(p.amount || 0) > 0)
        .map(p => normalizeSymbol(p.symbol)),
    );
    const reentryBlocked = openSymbols.has(symbol);
    checks.open_position_reentry = {
      passed: !reentryBlocked,
      detail: reentryBlocked ? `symbol=${symbol} 오픈 포지션 존재` : undefined,
    };
    if (reentryBlocked) blockedBy.push('open_position_reentry');
  }

  // ── duplicate_fire_cooldown (entry_triggers 테이블, 기본 10분) ───────
  const recentFired = recentFiredTriggers[0] || null;
  const fireCooldownBlocked = !!recentFired;
  checks.duplicate_fire_cooldown = {
    passed: !fireCooldownBlocked,
    detail: fireCooldownBlocked
      ? `recentFiredTriggerId=${recentFired.id}, firedAt=${recentFired.fired_at}, cooldown=${DEFAULT_FIRE_COOLDOWN_MINUTES}분`
      : undefined,
  };
  if (fireCooldownBlocked) blockedBy.push('duplicate_fire_cooldown');

  // ── signal 중복 dedup (signals 테이블, dedupeWindow 분) ──────────────
  const dupSignal = recentSignals[0] || null;
  const dupBlocked = !!dupSignal;
  checks.signal_dedup = {
    passed: !dupBlocked,
    detail: dupBlocked
      ? `duplicateId=${dupSignal.id}, window=${dedupeWindow}분`
      : undefined,
  };
  if (dupBlocked) blockedBy.push('signal_dedup');

  // ── race guard: 동시 실행 근접시각 중복 주문 (30초 창) ───────────────
  const raceSignal = raceSignals[0] || null;
  const raceBlocked = !!raceSignal;
  checks.race_guard = {
    passed: !raceBlocked,
    detail: raceBlocked
      ? `in-flight signalId=${raceSignal.id}, window=${RACE_GUARD_SECONDS}초`
      : undefined,
  };
  if (raceBlocked) blockedBy.push('race_guard');

  const decision = blockedBy.length > 0 ? 'block' : 'allow';
  const reason   = blockedBy.length > 0 ? blockedBy.join(', ') : 'all_passed';

  return { decision, reason, checks, blockedBy };
}

/**
 * SHADOW 기록 — 통합 가드 판정을 unified_guard_shadow 테이블에 저장.
 * ★ 실제 실행 흐름에 영향 없음.
 */
export async function runUnifiedGuardShadow(signal) {
  if (!isUnifiedGuardShadowEnabled()) return null;

  let result;
  try {
    result = await evaluateUnifiedGuard(signal);
  } catch (err) {
    console.warn(`[UNIFIED_GUARD_SHADOW] 판정 오류 symbol=${signal?.symbol}: ${err?.message}`);
    return null;
  }
  if (!result) return null;

  const existingStatus    = signal.status || null;
  const existingBlockCode = signal.block_code || null;
  // 기존 방어의 "block" 판정: status=blocked 또는 block_code 존재
  const existingIsBlocked = existingStatus === 'blocked' || !!existingBlockCode;

  const unifiedIsBlock = result.decision === 'block';
  const agreement = existingIsBlocked === unifiedIsBlock;
  // gap_flag: 기존=block, 통합=allow → 위험 공백 (0 지향)
  const gapFlag = existingIsBlocked && !unifiedIsBlock;

  try {
    await dbRun(
      `INSERT INTO unified_guard_shadow
         (signal_id, symbol, exchange, trade_mode, action,
          existing_decision, existing_block_code, existing_block_reason,
          unified_decision, unified_reason, unified_checks,
          agreement, gap_flag)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        signal.id   || null,
        normalizeSymbol(signal.symbol),
        signal.exchange   || 'binance',
        signal.trade_mode || 'normal',
        String(signal.action || '').toUpperCase(),
        existingStatus,
        existingBlockCode,
        signal.block_reason || null,
        result.decision,
        result.reason,
        JSON.stringify(result.checks),
        agreement,
        gapFlag,
      ],
    );
  } catch (err) {
    console.warn(`[UNIFIED_GUARD_SHADOW] DB 기록 오류 symbol=${signal?.symbol}: ${err?.message}`);
  }

  return { ...result, agreement, gapFlag };
}

/**
 * 배치 실행 — 최근 signals를 대상으로 shadow 평가 후 기록.
 * 이미 기록된 signal_id는 skip.
 *
 * @param options.limitSignals    처리 최대 건수 (기본 100)
 * @param options.minutesBack     조회 시간 범위 (기본 360분)
 * @param options.exchange        거래소 필터 (기본 전체)
 */
export async function runShadowBatchOnRecentSignals({
  limitSignals = 100,
  minutesBack  = 360,
  exchange     = null,
} = {}) {
  if (!isUnifiedGuardShadowEnabled()) {
    return { skipped: true, reason: 'UNIFIED_GUARD_SHADOW_ENABLED=false' };
  }

  const conditions = [`created_at > now() - ($1 * INTERVAL '1 minute')`];
  const params = [minutesBack];
  if (exchange) {
    params.push(exchange);
    conditions.push(`exchange = $${params.length}`);
  }
  params.push(limitSignals);

  const signals = await dbQuery(
    `SELECT id, symbol, action, amount_usdt, exchange, trade_mode,
            status, block_code, block_reason, created_at
       FROM signals
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${params.length}`,
    params,
  ).catch(() => []);

  let processed = 0;
  let skippedDup = 0;
  let gapCount = 0;
  let errorCount = 0;

  for (const sig of signals) {
    try {
      const already = await dbQuery(
        `SELECT id FROM unified_guard_shadow WHERE signal_id = $1 LIMIT 1`,
        [sig.id],
      ).catch(() => []);
      if (already.length > 0) { skippedDup++; continue; }

      const r = await runUnifiedGuardShadow(sig);
      if (r) {
        processed++;
        if (r.gapFlag) gapCount++;
      }
    } catch (err) {
      errorCount++;
      console.warn(`[SHADOW_BATCH] signal ${sig.id} 오류: ${err?.message}`);
    }
  }

  console.log(`[UNIFIED_GUARD_SHADOW] 배치 완료 — 처리=${processed}, skip(중복)=${skippedDup}, gap_flag=${gapCount}, 오류=${errorCount}, 전체=${signals.length}`);
  return { processed, skippedDup, gapCount, errorCount, total: signals.length };
}
