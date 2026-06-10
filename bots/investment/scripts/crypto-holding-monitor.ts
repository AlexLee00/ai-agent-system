#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/crypto-holding-monitor.ts
 *
 * 목적:
 *   - Binance(crypto) / KIS Overseas 포지션 중 보유일 초과 방치 포지션 탐지
 *   - 기술적 재평가(position-reevaluator) 후 SELL 권고 시 청산 신호 생성
 *   - Hard cap 초과 시 재평가 없이 강제 청산
 *   - launchd로 6시간마다 실행 (24/7 크립토 대응)
 *
 * 게이트 (기본: shadow/dry_run):
 *   LUNA_CRYPTO_STALE_SWEEP_ENABLED=false → dry_run만 (기본값)
 *   LUNA_REGIME_MAX_AGE_MIN=90
 *   LUNA_EXIT_MAXHOLD_BULL_DAYS=45
 *   LUNA_EXIT_MAXHOLD_BEAR_DAYS=5
 *   LUNA_EXIT_MAXHOLD_RANGING_DAYS=12
 *   LUNA_EXIT_MAXHOLD_VOLATILE_DAYS=7
 *   LUNA_EXIT_MAXHOLD_UNKNOWN_DAYS=12
 *   LUNA_EXIT_HARD_MAX_HOLD_DAYS=60 (하드 캡, 재평가 없이 강제 청산)
 *
 * 실행:
 *   node bots/investment/scripts/crypto-holding-monitor.ts
 *   node bots/investment/scripts/crypto-holding-monitor.ts --dry-run
 *   node bots/investment/scripts/crypto-holding-monitor.ts --json
 */

import * as db from '../shared/db.ts';
import { runCliMain } from '../shared/cli-runtime.ts';
import { reevaluateOpenPositions } from '../shared/position-reevaluator.ts';
import { recordGuardEventNow } from '../shared/guard-event-recorder.ts';
import { executeSignal as executeBinanceSignal } from '../team/hephaestos.ts';
import { executeSignal as executeOverseasSignal } from '../team/hanul.ts';

const CRYPTO_SOFT_CAP_DAYS = Number(process.env.LUNA_CRYPTO_MAX_HOLD_DAYS ?? 14);
const OVERSEAS_SOFT_CAP_DAYS = Number(process.env.LUNA_OVERSEAS_MAX_HOLD_DAYS ?? 10);
const REGIME_MAX_AGE_MIN = Number(process.env.LUNA_REGIME_MAX_AGE_MIN ?? 90);
const HARD_CAP_DAYS = Number(process.env.LUNA_EXIT_HARD_MAX_HOLD_DAYS ?? process.env.LUNA_CRYPTO_HARD_MAX_HOLD_DAYS ?? 60);
const SWEEP_ENABLED = process.env.LUNA_CRYPTO_STALE_SWEEP_ENABLED === 'true';

const REGIME_EXIT_POLICY = {
  trending_bull: {
    maxHoldDays: Number(process.env.LUNA_EXIT_MAXHOLD_BULL_DAYS ?? 45),
    timeOnlyExit: false,
    description: '추세장 승자 보유, 시간만으로 청산 금지',
  },
  trending_bear: {
    maxHoldDays: Number(process.env.LUNA_EXIT_MAXHOLD_BEAR_DAYS ?? 5),
    timeOnlyExit: true,
    description: '하락장 빠른 청산 편향',
  },
  ranging: {
    maxHoldDays: Number(process.env.LUNA_EXIT_MAXHOLD_RANGING_DAYS ?? 12),
    timeOnlyExit: true,
    description: '횡보장 중기 상한',
  },
  volatile: {
    maxHoldDays: Number(process.env.LUNA_EXIT_MAXHOLD_VOLATILE_DAYS ?? 7),
    timeOnlyExit: true,
    description: '고변동장 짧은 상한',
  },
  unknown: {
    maxHoldDays: Number(process.env.LUNA_EXIT_MAXHOLD_UNKNOWN_DAYS ?? 12),
    timeOnlyExit: true,
    description: '신선도 미달 보수 정책',
  },
};

function parseArgs(argv = process.argv.slice(2)) {
  return {
    dryRun: argv.includes('--dry-run') || !SWEEP_ENABLED,
    json: argv.includes('--json'),
  };
}

function calcHeldDays(entryTimeMs) {
  if (!entryTimeMs) return 0;
  return (Date.now() - Number(entryTimeMs)) / 86400000;
}

function calcPositionValue(pos) {
  return Number(pos.amount ?? 0) * Number(pos.avg_price ?? 0);
}

function getSoftCapDays(exchange) {
  return String(exchange).startsWith('kis_overseas') ? OVERSEAS_SOFT_CAP_DAYS : CRYPTO_SOFT_CAP_DAYS;
}

function marketForExchange(exchange) {
  if (String(exchange).startsWith('kis_overseas')) return 'overseas';
  if (String(exchange).startsWith('kis')) return 'domestic';
  return 'crypto';
}

function regimeLookupKeys(market) {
  if (market === 'crypto') return ['crypto', 'binance'];
  if (market === 'overseas') return ['overseas', 'kis_overseas'];
  if (market === 'domestic') return ['domestic', 'kis'];
  return [market].filter(Boolean);
}

function normalizeRegime(regime) {
  const value = String(regime || '').trim().toLowerCase();
  if (value.includes('bull')) return 'trending_bull';
  if (value.includes('bear')) return 'trending_bear';
  if (value.includes('volatile')) return 'volatile';
  if (value.includes('range') || value.includes('sideways')) return 'ranging';
  return value || 'unknown';
}

function isFreshRegime(snapshot) {
  if (!snapshot?.captured_at) return false;
  const capturedAt = new Date(snapshot.captured_at).getTime();
  return Number.isFinite(capturedAt) && (Date.now() - capturedAt) <= REGIME_MAX_AGE_MIN * 60_000;
}

async function loadRegimeByMarket() {
  const markets = ['crypto', 'overseas'];
  const entries = await Promise.all(markets.map(async (market) => {
    for (const key of regimeLookupKeys(market)) {
      const snapshot = await db.getLatestMarketRegimeSnapshot(key).catch(() => null);
      if (snapshot) return [market, snapshot];
    }
    return [market, null];
  }));
  return Object.fromEntries(entries);
}

function resolveRegimePolicy(snapshot) {
  const fresh = isFreshRegime(snapshot);
  const regime = fresh ? normalizeRegime(snapshot?.regime) : 'unknown';
  const policy = REGIME_EXIT_POLICY[regime] || REGIME_EXIT_POLICY.unknown;
  return {
    regime,
    fresh,
    confidence: fresh ? Number(snapshot?.confidence ?? 0) : 0,
    capturedAt: snapshot?.captured_at ?? null,
    ...policy,
  };
}

function getExecuteSignalFn(exchange) {
  return String(exchange).startsWith('kis_overseas') ? executeOverseasSignal : executeBinanceSignal;
}

async function identifyStaleCandidates() {
  const [cryptoResult, overseasResult] = await Promise.allSettled([
    db.getOpenPositions('binance', false, 'normal'),
    db.getOpenPositions('kis_overseas', false, 'normal'),
  ]);

  const allPositions = [
    ...(cryptoResult.status === 'fulfilled' ? (cryptoResult.value ?? []) : []),
    ...(overseasResult.status === 'fulfilled' ? (overseasResult.value ?? []) : []),
  ];

  const regimeByMarket = await loadRegimeByMarket();
  const candidates = [];
  for (const pos of allPositions) {
    const heldDays = calcHeldDays(pos.entry_time);
    const market = marketForExchange(pos.exchange);
    const regimePolicy = resolveRegimePolicy(regimeByMarket[market]);
    const softCap = Number.isFinite(regimePolicy.maxHoldDays)
      ? regimePolicy.maxHoldDays
      : getSoftCapDays(pos.exchange);
    if (heldDays >= softCap || heldDays >= HARD_CAP_DAYS) {
      candidates.push({
        symbol: pos.symbol,
        exchange: pos.exchange,
        market,
        regime: regimePolicy.regime,
        regimeFresh: regimePolicy.fresh,
        regimeConfidence: regimePolicy.confidence,
        regimeCapturedAt: regimePolicy.capturedAt,
        regimePolicy,
        heldDays,
        positionValue: calcPositionValue(pos),
        tradeMode: pos.trade_mode ?? 'normal',
        amount: Number(pos.amount ?? 0),
        avgPrice: Number(pos.avg_price ?? 0),
        isHardCap: heldDays >= HARD_CAP_DAYS,
        softCapDays: softCap,
      });
    }
  }

  return candidates;
}

async function createStaleExitSignal(candidate, reasoning, executionOrigin = 'stale_holding_sweep') {
  const signalId = await db.insertSignal({
    symbol: candidate.symbol,
    action: 'SELL',
    amountUsdt: candidate.positionValue,
    confidence: 1,
    reasoning,
    exchange: candidate.exchange,
    tradeMode: candidate.tradeMode,
    nemesisVerdict: 'approved',
    approvedAt: new Date().toISOString(),
    executionOrigin,
    qualityFlag: 'exclude_from_learning',
    excludeFromLearning: true,
    incidentLink: executionOrigin,
  });
  const signal = await db.getSignalById(signalId);
  return {
    ...signal,
    exchange: candidate.exchange,
    trade_mode: candidate.tradeMode,
    exit_reason_override: executionOrigin,
  };
}

async function runTechnicalReevaluation(candidate) {
  try {
    const revalResults = await reevaluateOpenPositions({
      exchange: candidate.exchange,
      symbol: candidate.symbol,
      paper: false,
      persist: false,
      liveIndicators: true,
      eventSource: 'stale_holding_sweep',
    });
    const item = Array.isArray(revalResults)
      ? revalResults.find((r) => String(r.symbol).toUpperCase() === String(candidate.symbol).toUpperCase())
      : null;
    return {
      recommendation: item?.recommendation ?? null,
      reason: item?.reason ?? item?.reasonCode ?? '재평가 결과 없음',
    };
  } catch (err) {
    return { recommendation: null, reason: `재평가 오류: ${err.message}` };
  }
}

function isSellRecommendation(recommendation) {
  return !recommendation || recommendation === 'SELL' || recommendation === 'ADJUST';
}

async function recordExitDecision(candidate, decision, details = {}) {
  await recordGuardEventNow({
    guardName: 'regime_dynamic_exit',
    symbol: candidate.symbol,
    exchange: candidate.exchange,
    market: candidate.market,
    reason: details.reason || decision,
    severity: decision.includes('EXIT') ? 'warning' : 'info',
    decisionBefore: {
      action: 'HOLD',
      heldDays: candidate.heldDays,
      positionValue: candidate.positionValue,
      regime: candidate.regime,
      regimeFresh: candidate.regimeFresh,
      softCapDays: candidate.softCapDays,
      hardCapDays: HARD_CAP_DAYS,
    },
    decisionAfter: {
      action: decision,
      dryRun: details.dryRun === true,
      recommendation: details.recommendation ?? null,
      reason: details.revalReason ?? null,
    },
    guardMetadata: {
      regimePolicy: candidate.regimePolicy,
      source: 'crypto-holding-monitor',
      executionOrigin: details.executionOrigin || 'regime_dynamic_exit',
    },
  });
}

async function main() {
  const options = parseArgs();
  const prefix = options.dryRun ? '[크립토보유모니터][DRY-RUN]' : '[크립토보유모니터]';

  if (options.dryRun && !process.argv.includes('--dry-run')) {
    console.log(`${prefix} LUNA_CRYPTO_STALE_SWEEP_ENABLED=false — shadow 모드 (실제 청산 없음)`);
  }

  const candidates = await identifyStaleCandidates();

  if (candidates.length === 0) {
    const msg = `${prefix} 방치 포지션 없음 (binance≥${CRYPTO_SOFT_CAP_DAYS}일, overseas≥${OVERSEAS_SOFT_CAP_DAYS}일)`;
    if (options.json) {
      console.log(JSON.stringify({ sweepEnabled: SWEEP_ENABLED, processed: 0, candidates: [] }));
    } else {
      console.log(msg);
    }
    return;
  }

  console.log(`${prefix} 방치 후보 ${candidates.length}건 탐지`);

  const results = [];

  for (const candidate of candidates) {
    const dayStr = candidate.heldDays.toFixed(1);
    const policy = candidate.regimePolicy || REGIME_EXIT_POLICY.unknown;
    const executionOrigin = 'regime_dynamic_exit';

    // ─── Hard cap: 재평가 없이 강제 청산 ────────────────────────
    if (candidate.isHardCap) {
      const reasoning = `체제별 동적 청산 hard cap 초과 (${dayStr}일 ≥ ${HARD_CAP_DAYS}일, regime=${candidate.regime}) — 강제 청산`;
      console.log(`${prefix} ${candidate.symbol} ${dayStr}일 hard cap regime=${candidate.regime} → 강제 청산`);

      if (!options.dryRun) {
        try {
          const signal = await createStaleExitSignal(candidate, reasoning, executionOrigin);
          const execResult = await getExecuteSignalFn(candidate.exchange)(signal);
          console.log(`  ✅ 청산 완료: ${candidate.symbol}`);
          results.push({ symbol: candidate.symbol, heldDays: candidate.heldDays, status: 'executed', capType: 'hard', execResult });
        } catch (err) {
          console.error(`  ❌ 청산 실패: ${candidate.symbol} — ${err.message}`);
          results.push({ symbol: candidate.symbol, heldDays: candidate.heldDays, status: 'error', capType: 'hard', error: err.message });
        }
      } else {
        await recordExitDecision(candidate, 'WOULD_EXIT_HARD_CAP', { dryRun: true, reason: reasoning, executionOrigin });
        results.push({ symbol: candidate.symbol, heldDays: candidate.heldDays, status: 'dry_run', capType: 'hard' });
      }
      continue;
    }

    // ─── Soft cap: 기술적 재평가 후 결정 ────────────────────────
    const reval = await runTechnicalReevaluation(candidate);
    const recommendation = reval.recommendation;
    const revalReason = reval.reason;

    const shouldSell = isSellRecommendation(recommendation);
    const timeOnlyBlocked = candidate.regime === 'trending_bull' && policy.timeOnlyExit === false && !shouldSell;
    const reasoning = `체제별 동적 청산 soft cap 초과 (${dayStr}일 ≥ ${candidate.softCapDays}일, regime=${candidate.regime}, fresh=${candidate.regimeFresh}), 재평가=${recommendation ?? 'null'}: ${revalReason}`;

    if (timeOnlyBlocked) {
      const holdReason = `추세장 보유 연장: ${candidate.symbol} ${dayStr}일 ≥ ${candidate.softCapDays}일이나 재평가=${recommendation ?? 'null'}로 시간 단독 청산 차단`;
      console.log(`${prefix} ${candidate.symbol} ${dayStr}일 regime=trending_bull → 시간 단독 청산 금지 (${revalReason})`);
      await recordExitDecision(candidate, 'HOLD_TRENDING_WINNER_TIME_ONLY_BLOCKED', {
        dryRun: options.dryRun,
        recommendation,
        revalReason,
        reason: holdReason,
        executionOrigin,
      });
      results.push({
        symbol: candidate.symbol,
        heldDays: candidate.heldDays,
        status: 'held',
        capType: 'soft',
        regime: candidate.regime,
        recommendation,
        revalReason,
        protectedBy: 'trending_bull_no_time_only_exit',
      });
      continue;
    }

    if (shouldSell) {
      console.log(`${prefix} ${candidate.symbol} ${dayStr}일 soft cap regime=${candidate.regime}, 재평가=${recommendation ?? 'null'} → 청산`);

      if (!options.dryRun) {
        try {
          const signal = await createStaleExitSignal(candidate, reasoning, executionOrigin);
          const execResult = await getExecuteSignalFn(candidate.exchange)(signal);
          console.log(`  ✅ 청산 완료: ${candidate.symbol}`);
          results.push({ symbol: candidate.symbol, heldDays: candidate.heldDays, status: 'executed', capType: 'soft', regime: candidate.regime, recommendation, execResult });
        } catch (err) {
          console.error(`  ❌ 청산 실패: ${candidate.symbol} — ${err.message}`);
          results.push({ symbol: candidate.symbol, heldDays: candidate.heldDays, status: 'error', capType: 'soft', error: err.message });
        }
      } else {
        await recordExitDecision(candidate, 'WOULD_EXIT_SOFT_CAP', {
          dryRun: true,
          recommendation,
          revalReason,
          reason: reasoning,
          executionOrigin,
        });
        results.push({ symbol: candidate.symbol, heldDays: candidate.heldDays, status: 'dry_run', capType: 'soft', regime: candidate.regime, recommendation, revalReason });
      }
    } else {
      // HOLD — 보유 연장, guard_events에 사유 기록
      console.log(`${prefix} ${candidate.symbol} ${dayStr}일 soft cap regime=${candidate.regime}, 재평가=${recommendation} → 보유 연장 (${revalReason})`);
      await recordExitDecision(candidate, 'HOLD_EXTENDED', {
        dryRun: options.dryRun,
        recommendation,
        revalReason,
        reason: reasoning,
        executionOrigin,
      });
      results.push({ symbol: candidate.symbol, heldDays: candidate.heldDays, status: 'held', capType: 'soft', regime: candidate.regime, recommendation, revalReason });
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ sweepEnabled: SWEEP_ENABLED, processed: results.length, results }));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCliMain({ run: main });
}

export { parseArgs, main };
export const __test = { recordExitDecision };
