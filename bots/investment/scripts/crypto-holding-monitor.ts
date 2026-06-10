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
import * as fs from 'node:fs';

const CRYPTO_SOFT_CAP_DAYS = Number(process.env.LUNA_CRYPTO_MAX_HOLD_DAYS ?? 14);
const OVERSEAS_SOFT_CAP_DAYS = Number(process.env.LUNA_OVERSEAS_MAX_HOLD_DAYS ?? 10);
const REGIME_MAX_AGE_MIN = Number(process.env.LUNA_REGIME_MAX_AGE_MIN ?? 90);
const HARD_CAP_DAYS = Number(process.env.LUNA_EXIT_HARD_MAX_HOLD_DAYS ?? process.env.LUNA_CRYPTO_HARD_MAX_HOLD_DAYS ?? 60);
const AGE_MISMATCH_WARN_DAYS = Number(process.env.LUNA_HOLDING_AGE_MISMATCH_WARN_DAYS ?? 7);
const SWEEP_ENABLED = process.env.LUNA_CRYPTO_STALE_SWEEP_ENABLED === 'true';
const MONITOR_STATE_URL = new URL('../output/ops/crypto-holding-monitor-state.json', import.meta.url);
const MONITOR_STATE_DIR_URL = new URL('../output/ops/', import.meta.url);

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

function toEpochMs(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function roundDays(value) {
  return Number(Number(value || 0).toFixed(2));
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

async function loadPositionAgeDiagnostics(positions = []) {
  const scoped = positions
    .filter((pos) => pos?.symbol && pos?.exchange)
    .map((pos) => ({
      symbol: String(pos.symbol),
      exchange: String(pos.exchange),
      paper: pos.paper === true,
      tradeMode: String(pos.trade_mode || 'normal'),
      monitorEntryTime: toEpochMs(pos.entry_time),
    }));

  if (scoped.length === 0) {
    return {
      status: 'ok',
      warningGapDays: AGE_MISMATCH_WARN_DAYS,
      mismatchCount: 0,
      maxGapDays: 0,
      rows: [],
    };
  }

  const params = [];
  const tuples = scoped.map((item) => {
    params.push(item.symbol, item.exchange, item.paper, item.tradeMode, item.monitorEntryTime);
    const base = params.length - 4;
    return `($${base}::text, $${base + 1}::text, $${base + 2}::boolean, $${base + 3}::text, $${base + 4}::bigint)`;
  }).join(', ');

  let queryError = null;
  const rows = await db.query(
    `WITH input(symbol, exchange, paper, position_trade_mode, monitor_entry_time) AS (
       VALUES ${tuples}
     ),
     trade_stats AS (
       SELECT i.symbol, i.exchange, i.paper,
              MIN(t.executed_at) FILTER (WHERE t.side = 'buy') AS first_buy_at,
              MAX(t.executed_at) FILTER (WHERE t.side = 'buy') AS last_buy_at,
              COUNT(*) FILTER (WHERE t.side = 'buy') AS buy_count,
              COUNT(*) FILTER (WHERE t.side IN ('sell','liquidate')) AS sell_count
         FROM input i
         LEFT JOIN investment.trades t
           ON t.symbol = i.symbol
          AND t.exchange = i.exchange
          AND COALESCE(t.paper, false) = i.paper
        GROUP BY i.symbol, i.exchange, i.paper
     ),
     journal_stats AS (
       SELECT i.symbol, i.exchange, i.paper,
              MIN(tj.entry_time) AS open_journal_entry_time,
              ARRAY_REMOVE(ARRAY_AGG(DISTINCT COALESCE(tj.trade_mode, 'normal')) FILTER (WHERE tj.status = 'open'), NULL) AS open_journal_trade_modes
         FROM input i
         LEFT JOIN investment.trade_journal tj
           ON tj.symbol = i.symbol
          AND tj.exchange = i.exchange
          AND tj.is_paper = i.paper
          AND tj.status = 'open'
        GROUP BY i.symbol, i.exchange, i.paper
     )
     SELECT i.symbol, i.exchange, i.paper, i.position_trade_mode, i.monitor_entry_time,
            ts.first_buy_at, ts.last_buy_at, ts.buy_count, ts.sell_count,
            js.open_journal_entry_time, js.open_journal_trade_modes
       FROM input i
       LEFT JOIN trade_stats ts USING (symbol, exchange, paper)
       LEFT JOIN journal_stats js USING (symbol, exchange, paper)
      ORDER BY i.symbol`,
    params,
  ).catch((err) => {
    queryError = err?.message || String(err);
    return [];
  });

  if (queryError) {
    return {
      status: 'error',
      error: queryError,
      warningGapDays: AGE_MISMATCH_WARN_DAYS,
      mismatchCount: 0,
      maxGapDays: 0,
      rows: [],
    };
  }

  const diagnostics = [];
  for (const row of rows || []) {
    const monitorEntryMs = toEpochMs(row.monitor_entry_time);
    const firstBuyMs = toEpochMs(row.first_buy_at);
    if (!monitorEntryMs || !firstBuyMs) continue;

    const rawHeldDays = (Date.now() - firstBuyMs) / 86400000;
    const monitorHeldDays = (Date.now() - monitorEntryMs) / 86400000;
    const ageGapDays = Math.max(0, (monitorEntryMs - firstBuyMs) / 86400000);
    const openModes = Array.isArray(row.open_journal_trade_modes)
      ? row.open_journal_trade_modes.map((mode) => String(mode))
      : [];
    const tradeModeMismatch = openModes.length > 0 && !openModes.includes(String(row.position_trade_mode || 'normal'));
    const isMismatch = ageGapDays >= AGE_MISMATCH_WARN_DAYS || tradeModeMismatch;

    if (!isMismatch) continue;

    diagnostics.push({
      symbol: row.symbol,
      exchange: row.exchange,
      paper: row.paper === true,
      positionTradeMode: row.position_trade_mode || 'normal',
      openJournalTradeModes: openModes,
      monitorHeldDays: roundDays(monitorHeldDays),
      rawTradeHeldDays: roundDays(rawHeldDays),
      ageGapDays: roundDays(ageGapDays),
      buyCount: Number(row.buy_count || 0),
      sellCount: Number(row.sell_count || 0),
      firstBuyAt: row.first_buy_at ? new Date(row.first_buy_at).toISOString() : null,
      monitorEntryAt: monitorEntryMs ? new Date(monitorEntryMs).toISOString() : null,
      reason: tradeModeMismatch ? 'open_journal_trade_mode_mismatch' : 'raw_trade_age_exceeds_monitor_age',
    });
  }

  diagnostics.sort((a, b) => Number(b.ageGapDays || 0) - Number(a.ageGapDays || 0));

  return {
    status: 'ok',
    warningGapDays: AGE_MISMATCH_WARN_DAYS,
    mismatchCount: diagnostics.length,
    maxGapDays: diagnostics.length > 0 ? Number(diagnostics[0].ageGapDays || 0) : 0,
    rows: diagnostics.slice(0, 20),
  };
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
  const ageDiagnostics = await loadPositionAgeDiagnostics(allPositions);
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

  return { candidates, ageDiagnostics };
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

function summarizeCandidate(candidate = {}) {
  return {
    symbol: candidate.symbol,
    exchange: candidate.exchange,
    market: candidate.market,
    regime: candidate.regime,
    regimeFresh: candidate.regimeFresh === true,
    regimeConfidence: Number(candidate.regimeConfidence || 0),
    regimeCapturedAt: candidate.regimeCapturedAt ?? null,
    heldDays: Number(Number(candidate.heldDays || 0).toFixed(2)),
    positionValue: Number(Number(candidate.positionValue || 0).toFixed(4)),
    tradeMode: candidate.tradeMode ?? 'normal',
    softCapDays: Number(candidate.softCapDays || 0),
    hardCapDays: HARD_CAP_DAYS,
    isHardCap: candidate.isHardCap === true,
  };
}

function summarizeResult(result = {}) {
  return {
    symbol: result.symbol,
    heldDays: Number(Number(result.heldDays || 0).toFixed(2)),
    status: result.status,
    capType: result.capType ?? null,
    regime: result.regime ?? null,
    recommendation: result.recommendation ?? null,
    revalReason: result.revalReason ?? null,
    protectedBy: result.protectedBy ?? null,
    error: result.error ?? null,
  };
}

function countBy(items = [], key) {
  return items.reduce((acc, item) => {
    const value = String(item?.[key] ?? 'unknown');
    acc[value] = Number(acc[value] || 0) + 1;
    return acc;
  }, {});
}

function buildMonitorStatePayload({ options = parseArgs([]), candidates = [], results = [], status = 'completed', ageDiagnostics = null } = {}) {
  const summarizedCandidates = candidates.map(summarizeCandidate);
  const summarizedResults = results.map(summarizeResult);
  return {
    ok: status !== 'error',
    generatedAt: new Date().toISOString(),
    source: 'crypto-holding-monitor',
    status,
    sweepEnabled: SWEEP_ENABLED,
    dryRun: options.dryRun === true,
    candidateCount: summarizedCandidates.length,
    processed: summarizedResults.length,
    counts: {
      candidatesByMarket: countBy(summarizedCandidates, 'market'),
      candidatesByRegime: countBy(summarizedCandidates, 'regime'),
      resultsByStatus: countBy(summarizedResults, 'status'),
      resultsByCapType: countBy(summarizedResults, 'capType'),
    },
    policy: {
      cryptoSoftCapDays: CRYPTO_SOFT_CAP_DAYS,
      overseasSoftCapDays: OVERSEAS_SOFT_CAP_DAYS,
      hardCapDays: HARD_CAP_DAYS,
      regimeMaxAgeMin: REGIME_MAX_AGE_MIN,
      regimeExitPolicy: REGIME_EXIT_POLICY,
    },
    positionAgeDiagnostics: ageDiagnostics || {
      status: 'ok',
      warningGapDays: AGE_MISMATCH_WARN_DAYS,
      mismatchCount: 0,
      maxGapDays: 0,
      rows: [],
    },
    candidates: summarizedCandidates,
    results: summarizedResults,
  };
}

function writeMonitorState(payload) {
  try {
    fs.mkdirSync(MONITOR_STATE_DIR_URL, { recursive: true });
    fs.writeFileSync(MONITOR_STATE_URL, `${JSON.stringify(payload, null, 2)}\n`);
  } catch (err) {
    console.error(`[크립토보유모니터] 상태 파일 기록 실패: ${err?.message || String(err)}`);
  }
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

  const { candidates, ageDiagnostics } = await identifyStaleCandidates();

  if (candidates.length === 0) {
    const state = buildMonitorStatePayload({ options, candidates, results: [], status: 'no_candidates', ageDiagnostics });
    writeMonitorState(state);
    const msg = `${prefix} 방치 포지션 없음 (binance≥${CRYPTO_SOFT_CAP_DAYS}일, overseas≥${OVERSEAS_SOFT_CAP_DAYS}일)`;
    if (options.json) {
      console.log(JSON.stringify({ sweepEnabled: SWEEP_ENABLED, processed: 0, candidates: [], state }));
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

  const state = buildMonitorStatePayload({ options, candidates, results, status: 'completed', ageDiagnostics });
  writeMonitorState(state);
  if (options.json) {
    console.log(JSON.stringify({ sweepEnabled: SWEEP_ENABLED, processed: results.length, results, state }));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCliMain({ run: main });
}

export { parseArgs, main };
export const __test = { recordExitDecision, buildMonitorStatePayload, loadPositionAgeDiagnostics };
