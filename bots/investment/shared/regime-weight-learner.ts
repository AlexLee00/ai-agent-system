// @ts-nocheck
// regime-weight-learner.ts — 체제별 fusion + signal 가중치 DB 기반 학습
// 수익률 기반 밴딧(Bandit) 방식으로 4 체제별 가중치를 점진적 개선
// 매일 07:00 실행 (ai.luna.weight-adaptive-tuner-daily-0700.plist)
// 결과 → investment.luna_regime_weight_snapshots 테이블 저장

import { query } from './db/core.ts';
import { persistAdaptedWeights, retrieveAdaptedWeights } from './ta-weight-adaptive-tuner.ts';
import { REGIME_AXIS_WEIGHTS } from './dynamic-universe-selector.ts';
import { learningPnlValidSql } from './trade-journal-learning-guard.ts';
import { sanitizeLunaLearnedBiasWeightMap } from './luna-data-contracts.ts';
import { fetchLunaLearnedBiasVaultRows } from '../../sigma/shared/luna-learned-bias-feed.ts';

// ─── 환경 게이트 ──────────────────────────────────────────────────────────────
function boolEnv(name, fallback = false, env = process.env) {
  const raw = String(env?.[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function numEnv(name, fallback = 0, env = process.env) {
  const raw = Number(env?.[name]);
  return Number.isFinite(raw) ? raw : fallback;
}

export const REGIME_WEIGHT_LEARNER_ENABLED_KEY = 'LUNA_ADAPTIVE_WEIGHT_ENABLED';
export const DEFAULT_WEIGHT_LEARNER_LOOKBACK_DAYS = 30;
export const DEFAULT_WEIGHT_LEARNER_ADAPTIVE_WINDOWS = Object.freeze([30, 60, 90, 180]);
export const DEFAULT_WEIGHT_LEARNER_MIN_TRADES = 3;

// ─── 4 체제 기본 fusion 가중치 (REGIME_GUIDES 기반) ─────────────────────────
// fusion: [기술분석, 온체인/펀더, 감성/뉴스, WorldQuant]

export const BASE_FUSION_WEIGHTS = {
  TRENDING_BULL:  { ta: 0.40, fundamental: 0.20, sentiment: 0.20, worldquant: 0.20 },
  TRENDING_BEAR:  { ta: 0.25, fundamental: 0.35, sentiment: 0.25, worldquant: 0.15 },
  RANGING:        { ta: 0.25, fundamental: 0.25, sentiment: 0.20, worldquant: 0.30 },
  VOLATILE:       { ta: 0.20, fundamental: 0.30, sentiment: 0.30, worldquant: 0.20 },
};

// ─── 4 체제 기본 signal 가중치 ────────────────────────────────────────────────
export const BASE_SIGNAL_WEIGHTS = {
  TRENDING_BULL:  { momentum: 0.35, breakout: 0.30, mean_reversion: 0.15, defensive: 0.20 },
  TRENDING_BEAR:  { momentum: 0.15, breakout: 0.15, mean_reversion: 0.40, defensive: 0.30 },
  RANGING:        { momentum: 0.15, breakout: 0.15, mean_reversion: 0.50, defensive: 0.20 },
  VOLATILE:       { momentum: 0.15, breakout: 0.20, mean_reversion: 0.20, defensive: 0.45 },
};

// ─── 체제 정규화 ──────────────────────────────────────────────────────────────
function normalizeRegime(regime = 'RANGING') {
  const r = String(regime || 'RANGING').toUpperCase();
  if (r.includes('BULL'))  return 'TRENDING_BULL';
  if (r.includes('BEAR'))  return 'TRENDING_BEAR';
  if (r.includes('VOLAT')) return 'VOLATILE';
  return 'RANGING';
}

// ─── 가중치 정규화 (합 = 1.0) ─────────────────────────────────────────────────
function normalizeWeights(weights) {
  const entries = Object.entries(weights).filter(([, v]) => typeof v === 'number' && !isNaN(v));
  const total = entries.reduce((s, [, v]) => s + Math.max(0, v), 0);
  if (total <= 0) return Object.fromEntries(entries);
  return Object.fromEntries(entries.map(([k, v]) => [k, Math.max(0, v) / total]));
}

// ─── DB 거래 이력 조회 (체제 + 지표별) ────────────────────────────────────────

async function fetchRegimeTradeStats(days = DEFAULT_WEIGHT_LEARNER_LOOKBACK_DAYS, queryFn = query) {
  // trade_journal: exit_time(ms), is_paper, pnl_net/pnl_amount, market_regime, strategy_family/trade_mode, market
  const rows = await queryFn(
    `SELECT
       COALESCE(tj.market_regime, 'RANGING')  AS regime,
       COALESCE(tj.strategy_family, tj.trade_mode, 'momentum') AS signal_type,
       COALESCE(tj.market, 'crypto')           AS market,
       COUNT(*)                               AS total_trades,
       COUNT(*) FILTER (WHERE COALESCE(tj.pnl_net, tj.pnl_amount, 0) > 0) AS win_trades,
       AVG(COALESCE(tj.pnl_net, tj.pnl_amount, 0)) AS avg_pnl,
       AVG(COALESCE(
         CASE
           WHEN tj.pnl_percent IS NOT NULL AND ABS(tj.pnl_percent) <= 1000 THEN tj.pnl_percent
           WHEN tj.entry_price > 0 AND tj.exit_price IS NOT NULL THEN
             CASE
               WHEN LOWER(COALESCE(tj.direction, 'long')) IN ('short', 'sell') THEN
                 ((tj.entry_price - tj.exit_price) / tj.entry_price) * 100
               ELSE
                 ((tj.exit_price - tj.entry_price) / tj.entry_price) * 100
             END
           ELSE NULL
         END,
         0
       )) AS avg_pnl_pct,
       SUM(CASE WHEN COALESCE(tj.pnl_net, tj.pnl_amount, 0) > 0 THEN COALESCE(tj.pnl_net, tj.pnl_amount, 0) ELSE 0 END) AS gross_profit,
       SUM(CASE WHEN COALESCE(tj.pnl_net, tj.pnl_amount, 0) < 0 THEN ABS(COALESCE(tj.pnl_net, tj.pnl_amount, 0)) ELSE 0 END) AS gross_loss
     FROM investment.trade_journal tj
     WHERE tj.exit_time IS NOT NULL
       AND NOT COALESCE(tj.is_paper, false)
       AND ${learningPnlValidSql('tj')}
       AND to_timestamp(tj.exit_time / 1000.0) >= NOW() - ($1 || ' days')::interval
     GROUP BY COALESCE(tj.market_regime, 'RANGING'), COALESCE(tj.strategy_family, tj.trade_mode, 'momentum'), COALESCE(tj.market, 'crypto')
     ORDER BY total_trades DESC`,
    [days],
  ).catch(() => []);

  return rows || [];
}

function parseAdaptiveWindows(initialDays, env = process.env) {
  const raw = String(env?.LUNA_WEIGHT_LEARNER_ADAPTIVE_WINDOWS || '').trim();
  const configured = raw
    ? raw.split(',').map((item) => Number(item.trim())).filter((value) => Number.isFinite(value) && value > 0)
    : [...DEFAULT_WEIGHT_LEARNER_ADAPTIVE_WINDOWS];
  return [...new Set([Number(initialDays), ...configured])]
    .filter((value) => Number.isFinite(value) && value >= Number(initialDays))
    .map((value) => Math.floor(value))
    .sort((a, b) => a - b);
}

async function buildAdaptiveRegimeDataset({
  initialDays,
  env = process.env,
  minTrades = DEFAULT_WEIGHT_LEARNER_MIN_TRADES,
  fetchFn = fetchRegimeTradeStats,
}) {
  const windows = parseAdaptiveWindows(initialDays, env);
  const targetRegimes = Object.keys(BASE_FUSION_WEIGHTS);
  const rowsByWindow = new Map();
  const performanceByWindow = new Map();
  const selected = {};

  for (const days of windows) {
    const rows = await fetchFn(days);
    const performance = computeRegimePerformance(rows);
    rowsByWindow.set(days, rows);
    performanceByWindow.set(days, performance);
    for (const regime of targetRegimes) {
      if (!selected[regime] && Number(performance?.[regime]?.totalTrades || 0) >= minTrades) {
        selected[regime] = {
          regime,
          days,
          totalTrades: Number(performance[regime].totalTrades || 0),
          reason: days === Number(initialDays) ? 'initial_window_sufficient' : 'adaptive_window_selected',
        };
      }
    }
    if (targetRegimes.every((regime) => selected[regime])) break;
  }

  const fallbackDays = windows[windows.length - 1] || initialDays;
  const fallbackPerformance = performanceByWindow.get(fallbackDays) || {};
  for (const regime of targetRegimes) {
    if (!selected[regime]) {
      selected[regime] = {
        regime,
        days: fallbackDays,
        totalTrades: Number(fallbackPerformance?.[regime]?.totalTrades || 0),
        reason: 'max_window_insufficient',
      };
    }
  }

  const finalRows = [];
  for (const regime of targetRegimes) {
    const days = selected[regime].days;
    const rows = rowsByWindow.get(days) || [];
    finalRows.push(...rows.filter((row) => normalizeRegime(row.regime || 'RANGING') === regime));
  }

  return {
    rows: finalRows,
    windows,
    selected,
    maxSelectedDays: Math.max(...Object.values(selected).map((item) => Number(item.days || initialDays))),
    fetchedWindows: [...rowsByWindow.keys()],
  };
}

// ─── 체제별 승률 + 손익비 계산 ────────────────────────────────────────────────

function computeRegimePerformance(rows) {
  const stats = {};

  for (const row of rows) {
    const regime = normalizeRegime(row.regime || 'RANGING');
    if (!stats[regime]) {
      stats[regime] = { totalTrades: 0, winTrades: 0, grossProfit: 0, grossLoss: 0, signalWins: {} };
    }
    const s = stats[regime];
    s.totalTrades += Number(row.total_trades || 0);
    s.winTrades += Number(row.win_trades || 0);
    s.grossProfit += Number(row.gross_profit || 0);
    s.grossLoss += Number(row.gross_loss || 0);

    // signal_type별 승률 추적
    const signalType = String(row.signal_type || 'momentum').toLowerCase();
    if (!s.signalWins[signalType]) s.signalWins[signalType] = { wins: 0, total: 0 };
    s.signalWins[signalType].wins += Number(row.win_trades || 0);
    s.signalWins[signalType].total += Number(row.total_trades || 0);
  }

  // 승률 + 손익비 계산
  for (const [regime, s] of Object.entries(stats)) {
    s.winRate = s.totalTrades > 0 ? s.winTrades / s.totalTrades : 0;
    s.profitFactor = s.grossLoss > 0 ? s.grossProfit / s.grossLoss : (s.grossProfit > 0 ? 2.0 : 0);
    s.expectedValue = s.winRate * s.grossProfit - (1 - s.winRate) * s.grossLoss;

    for (const [stype, sw] of Object.entries(s.signalWins)) {
      sw.winRate = sw.total > 0 ? sw.wins / sw.total : 0;
    }
  }

  return stats;
}

// ─── 밴딧 방식 가중치 조정 ────────────────────────────────────────────────────
// 성과 좋은 체제 → 가중치 ↑, 나쁜 체제 → ↓
// 변화량 상한: ±0.05 per cycle (보수적)

const MAX_DELTA = 0.05;
const MIN_WEIGHT = 0.05;
const MAX_WEIGHT = 0.60;

function adjustWeightsFromPerformance(baseWeights, performance, learnRate = 0.08) {
  const updated = {};

  for (const [regime, base] of Object.entries(baseWeights)) {
    const perf = performance[regime];
    if (!perf || perf.totalTrades < 3) {
      updated[regime] = { ...base };
      continue;
    }

    const winRateDelta = perf.winRate - 0.5; // 0.5 기준 초과분
    const pfDelta = Math.min(1.0, perf.profitFactor - 1.0); // 1.0 기준 초과분
    const score = (winRateDelta * 0.6 + pfDelta * 0.4); // 종합 점수

    const adjustFactor = 1 + learnRate * Math.max(-1, Math.min(1, score));
    const newWeights = {};
    for (const [k, v] of Object.entries(base)) {
      const adjusted = Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, v * adjustFactor));
      const delta = adjusted - v;
      const clamped = v + Math.max(-MAX_DELTA, Math.min(MAX_DELTA, delta));
      newWeights[k] = Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, clamped));
    }
    updated[regime] = normalizeWeights(newWeights);
  }

  return updated;
}

// ─── signal 가중치 조정 (signal_type별 성과 기반) ───────────────────────────

function adjustSignalWeightsFromPerformance(baseSignalWeights, performance, learnRate = 0.08) {
  const updated = {};

  for (const [regime, base] of Object.entries(baseSignalWeights)) {
    const perf = performance[regime];
    if (!perf || perf.totalTrades < 3) {
      updated[regime] = { ...base };
      continue;
    }

    const newWeights = { ...base };
    for (const [signalType, sw] of Object.entries(perf.signalWins || {})) {
      if (sw.total < 2) continue;
      const delta = (sw.winRate - 0.5) * learnRate;
      const key = signalType.replace(/-/g, '_'); // normalize
      if (key in newWeights) {
        const newVal = Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, (newWeights[key] || 0.2) + Math.max(-MAX_DELTA, Math.min(MAX_DELTA, delta))));
        newWeights[key] = newVal;
      }
    }
    updated[regime] = normalizeWeights(newWeights);
  }

  return updated;
}

function maxMapDelta(current = {}, previous = {}) {
  const keys = new Set([...Object.keys(current || {}), ...Object.keys(previous || {})]);
  let max = 0;
  for (const key of keys) {
    const delta = Math.abs(Number(current?.[key] || 0) - Number(previous?.[key] || 0));
    if (Number.isFinite(delta)) max = Math.max(max, delta);
  }
  return Number(max.toFixed(6));
}

function indexLatestWeights(rows = []) {
  const indexed = {};
  for (const row of rows || []) {
    if (!row?.regime) continue;
    indexed[normalizeRegime(row.regime)] = row;
  }
  return indexed;
}

async function fetchRecentRegimeWeightSnapshots(days = 5, queryFn = query) {
  return await queryFn(
    `SELECT regime, fusion_weights, signal_weights, total_trades, created_at
       FROM investment.luna_regime_weight_snapshots
      WHERE created_at >= NOW() - ($1 || ' days')::interval
      ORDER BY created_at DESC`,
    [days],
  ).catch(() => []);
}

function buildWeightDiagnostics(snapshots = [], previousRows = [], options = {}) {
  const minTrades = Number(options.minTrades || DEFAULT_WEIGHT_LEARNER_MIN_TRADES);
  const previousByRegime = indexLatestWeights(previousRows);
  return (snapshots || []).map((snapshot) => {
    const previous = previousByRegime[normalizeRegime(snapshot.regime)] || {};
    const fusionDelta = maxMapDelta(snapshot.fusionWeights, previous.fusionWeights || previous.fusion_weights || BASE_FUSION_WEIGHTS[snapshot.regime]);
    const signalDelta = maxMapDelta(snapshot.signalWeights, previous.signalWeights || previous.signal_weights || BASE_SIGNAL_WEIGHTS[snapshot.regime]);
    const totalTrades = Number(snapshot.totalTrades || 0);
    return {
      regime: snapshot.regime,
      totalTrades,
      fusionDelta,
      signalDelta,
      insufficientSample: totalTrades < minTrades,
      unchanged: fusionDelta === 0 && signalDelta === 0,
    };
  });
}

function snapshotDate(row = {}) {
  const raw = String(row.createdAt || row.created_at || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function snapshotWeightMap(row = {}, camelKey, snakeKey) {
  const value = row?.[camelKey] ?? row?.[snakeKey];
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  return typeof value === 'object' ? value : null;
}

function snapshotTotalTrades(row = {}) {
  return Number(row.totalTrades ?? row.total_trades ?? 0);
}

function snapshotUnchangedFromPrevious(row = {}, previousByRegime = {}) {
  const regime = normalizeRegime(row.regime || 'RANGING');
  const previous = previousByRegime[regime];
  if (!previous) return false;
  const currentFusion = snapshotWeightMap(row, 'fusionWeights', 'fusion_weights');
  const previousFusion = snapshotWeightMap(previous, 'fusionWeights', 'fusion_weights');
  const currentSignal = snapshotWeightMap(row, 'signalWeights', 'signal_weights');
  const previousSignal = snapshotWeightMap(previous, 'signalWeights', 'signal_weights');
  if (!currentFusion || !previousFusion || !currentSignal || !previousSignal) return false;
  return maxMapDelta(currentFusion, previousFusion) === 0
    && maxMapDelta(currentSignal, previousSignal) === 0;
}

function countConsecutiveRecentStallDays(recentRows = [], minTrades = DEFAULT_WEIGHT_LEARNER_MIN_TRADES) {
  const rowsByDate = new Map();
  for (const row of recentRows || []) {
    const date = snapshotDate(row);
    if (!date) continue;
    if (!rowsByDate.has(date)) rowsByDate.set(date, []);
    rowsByDate.get(date).push(row);
  }

  const previousByRegime = {};
  const stalledByDate = new Map();
  const datesAsc = [...rowsByDate.keys()].sort();
  for (const date of datesAsc) {
    const rows = rowsByDate.get(date) || [];
    const stalled = rows.length > 0 && rows.every((row) => (
      snapshotTotalTrades(row) < minTrades || snapshotUnchangedFromPrevious(row, previousByRegime)
    ));
    stalledByDate.set(date, stalled);
    for (const row of rows) {
      if (row?.regime) previousByRegime[normalizeRegime(row.regime)] = row;
    }
  }

  let consecutive = 0;
  const datesDesc = [...rowsByDate.keys()].sort().reverse();
  for (const date of datesDesc) {
    if (!stalledByDate.get(date)) break;
    consecutive += 1;
  }
  return consecutive;
}

function summarizeLearnerStall(diagnostics = [], recentRows = [], options = {}) {
  const minTrades = Number(options.minTrades || DEFAULT_WEIGHT_LEARNER_MIN_TRADES);
  const stallDays = Math.max(1, Number(options.stallDays || 3));
  const currentRunStalled = diagnostics.length > 0
    && diagnostics.every((row) => row.unchanged || row.insufficientSample);
  const allWeightsUnchanged = diagnostics.length > 0
    && diagnostics.every((row) => row.unchanged);
  const insufficientRegimes = diagnostics
    .filter((row) => row.totalTrades < minTrades)
    .map((row) => row.regime);
  const observedRecentRows = Array.isArray(recentRows) ? recentRows.length : 0;
  const observedRecentDays = new Set((recentRows || [])
    .map((row) => String(row.createdAt || row.created_at || '').slice(0, 10))
    .filter(Boolean)).size;
  const consecutiveRecentStallDays = countConsecutiveRecentStallDays(recentRows, minTrades);
  const consecutiveStallDays = currentRunStalled ? consecutiveRecentStallDays + 1 : consecutiveRecentStallDays;
  const shouldAlert = currentRunStalled && consecutiveStallDays >= stallDays;
  return {
    currentRunStalled,
    shouldAlert,
    stallDaysThreshold: stallDays,
    consecutiveStallDays,
    consecutiveRecentStallDays,
    observedRecentRows,
    observedRecentDays,
    allWeightsUnchanged,
    insufficientRegimes,
    diagnostics,
  };
}

// ─── DB 스냅샷 저장 ──────────────────────────────────────────────────────────

async function saveWeightSnapshot(snapshot) {
  await query(
    `INSERT INTO investment.luna_regime_weight_snapshots
       (regime, fusion_weights, signal_weights, universe_weights,
        win_rate, profit_factor, performance_metric, total_trades, learn_rate, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT DO NOTHING`,
    [
      snapshot.regime,
      JSON.stringify(snapshot.fusionWeights),
      JSON.stringify(snapshot.signalWeights),
      JSON.stringify(snapshot.universeWeights || {}),
      snapshot.winRate,
      snapshot.profitFactor,
      snapshot.performanceMetric || 0,
      snapshot.totalTrades,
      snapshot.learnRate,
    ],
  ).catch((err) => {
    console.warn(`[RegimeWeightLearner] DB 저장 실패 (테이블 없음 무시): ${err?.message}`);
  });
}

async function saveWeightVectorShadow(snapshot) {
  await query(
    `INSERT INTO investment.luna_weight_vector_shadow
       (symbol, market, exchange, candidate_score, backtest_score, predictive_score,
        community_score, target_weight, confidence, risk_budget_usdt, signal,
        gate_status, no_lookahead_ok, shadow_only, evidence, observed_at)
     VALUES ($1, 'multi', 'all', $2, $3, $4, 0, 0, $5, 0, 'weight_update',
             'shadow', TRUE, TRUE, $6::jsonb, NOW())`,
    [
      `__REGIME_${snapshot.regime}__`,
      snapshot.winRate,
      snapshot.profitFactor,
      snapshot.performanceMetric || 0,
      snapshot.winRate,
      JSON.stringify({
        source: 'regime-weight-learner',
        regime: snapshot.regime,
        fusionWeights: snapshot.fusionWeights,
        signalWeights: snapshot.signalWeights,
        universeWeights: snapshot.universeWeights || {},
        totalTrades: snapshot.totalTrades,
        learnRate: snapshot.learnRate,
      }),
    ],
  ).catch((err) => {
    console.warn(`[RegimeWeightLearner] weight_vector_shadow 저장 실패 (테이블 없음 무시): ${err?.message}`);
  });
}

// ─── 메인 학습 함수 ──────────────────────────────────────────────────────────

export async function runRegimeWeightLearner(options = {}) {
  const env = options.env || process.env;
  const dryRun = options.dryRun === true;
  const queryFn = options.queryFn || query;
  const enabled = boolEnv(REGIME_WEIGHT_LEARNER_ENABLED_KEY, true, env);
  if (!enabled && !dryRun) {
    console.log(`[RegimeWeightLearner] 비활성화 (${REGIME_WEIGHT_LEARNER_ENABLED_KEY}=false/미설정)`);
    return { skipped: true, reason: 'disabled' };
  }
  if (!enabled && dryRun) {
    console.log(`[RegimeWeightLearner] ${REGIME_WEIGHT_LEARNER_ENABLED_KEY}=false/미설정 — dry-run 검증만 수행`);
  }

  const days = Number(options.days ?? numEnv('LUNA_WEIGHT_LEARNER_LOOKBACK_DAYS', DEFAULT_WEIGHT_LEARNER_LOOKBACK_DAYS, env)) || DEFAULT_WEIGHT_LEARNER_LOOKBACK_DAYS;
  const minTrades = Math.max(1, Number(options.minTrades ?? numEnv('LUNA_WEIGHT_LEARNER_MIN_TRADES', DEFAULT_WEIGHT_LEARNER_MIN_TRADES, env)));
  const stallDays = Math.max(1, Number(options.stallDays ?? numEnv('LUNA_WEIGHT_LEARNER_STALL_DAYS', 3, env)));
  const learnRate = Math.max(0.01, Math.min(0.20, numEnv('LUNA_TA_WEIGHT_ADAPTIVE_LEARN_RATE', 0.08, env)));

  console.log(`[RegimeWeightLearner] 학습 시작 — 기간: ${days}일, 학습률: ${learnRate}`);

  // 1. DB에서 거래 이력 조회
  const adaptive = await buildAdaptiveRegimeDataset({
    initialDays: days,
    env,
    minTrades,
    fetchFn: options.fetchRegimeTradeStats || ((lookbackDays) => fetchRegimeTradeStats(lookbackDays, queryFn)),
  });
  const rows = adaptive.rows;
  console.log(`[RegimeWeightLearner] 거래 이력: ${rows.length}행 (windows=${adaptive.fetchedWindows.join(',')})`);

  // 2. 체제별 성과 계산
  const performance = computeRegimePerformance(rows);

  // 3. fusion 가중치 조정
  const updatedFusion = adjustWeightsFromPerformance(BASE_FUSION_WEIGHTS, performance, learnRate);

  // 4. signal 가중치 조정
  const updatedSignal = adjustSignalWeightsFromPerformance(BASE_SIGNAL_WEIGHTS, performance, learnRate);

  // 5. TA 지표 가중치도 업데이트 (ta-weight-adaptive-tuner와 동기화)
  for (const [regime, _] of Object.entries(updatedFusion)) {
    const taWeights = retrieveAdaptedWeights(regime);
    if (!dryRun && performance[regime]?.totalTrades >= 3) {
      const winRate = performance[regime].winRate;
      const adjustFactor = 1 + learnRate * (winRate - 0.5);
      const adjusted = {};
      for (const [k, v] of Object.entries(taWeights)) {
        if (k.startsWith('_')) continue;
        adjusted[k] = Math.min(0.50, Math.max(0.01, v * adjustFactor));
      }
      persistAdaptedWeights(adjusted, regime);
    }
  }

  const previousRows = await (options.getLatestRegimeWeights || getLatestSnapshotRegimeWeights)(null).catch(() => []);
  const recentRows = Array.isArray(options.recentSnapshots)
    ? options.recentSnapshots
    : await (options.fetchRecentRegimeWeightSnapshots || ((lookbackDays) => fetchRecentRegimeWeightSnapshots(lookbackDays, queryFn)))(stallDays + 2).catch(() => []);

  // 6. DB 스냅샷 저장
  const snapshots = [];
  for (const [regime, fusionWeights] of Object.entries(updatedFusion)) {
    const perf = performance[regime] || {};
    const winRate = perf.winRate || 0;
    const profitFactor = perf.profitFactor || 0;
    const performanceMetric = Number((winRate * Math.min(2, profitFactor)).toFixed(6));
    const snapshot = {
      regime,
      fusionWeights,
      signalWeights: updatedSignal[regime] || BASE_SIGNAL_WEIGHTS[regime],
      universeWeights: REGIME_AXIS_WEIGHTS[regime] || REGIME_AXIS_WEIGHTS.RANGING || {},
      winRate,
      profitFactor,
      performanceMetric,
      totalTrades: perf.totalTrades || 0,
      learnRate,
    };
    snapshots.push(snapshot);
    if (!dryRun) {
      await saveWeightSnapshot(snapshot);
      await saveWeightVectorShadow(snapshot);
    }
  }

  const diagnostics = buildWeightDiagnostics(snapshots, previousRows, { minTrades });
  const stalled = summarizeLearnerStall(diagnostics, recentRows, { minTrades, stallDays });

  // 7. 결과 요약
  const summary = snapshots.map((s) => ({
    regime: s.regime,
    fusion: Object.entries(s.fusionWeights).map(([k, v]) => `${k}:${v.toFixed(2)}`).join(' '),
    winRate: (s.winRate * 100).toFixed(1) + '%',
    profitFactor: s.profitFactor.toFixed(2),
    trades: s.totalTrades,
  }));

  console.log(`[RegimeWeightLearner] 완료 — 체제: ${snapshots.length}개`);
  for (const s of summary) {
    console.log(`  ${s.regime}: 승률=${s.winRate} PF=${s.profitFactor} trades=${s.trades}`);
    console.log(`    fusion: ${s.fusion}`);
  }

  return {
    ok: true,
    enabled,
    dryRun,
    days,
    effectiveDays: adaptive.maxSelectedDays,
    minTrades,
    learnRate,
    regimesUpdated: snapshots.length,
    snapshots,
    performance,
    windowSelection: adaptive.selected,
    fetchedWindows: adaptive.fetchedWindows,
    diagnostics,
    stalled,
  };
}

// ─── 현재 학습된 가중치 조회 ────────────────────────────────────────────────

function parseVaultMeta(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return {};
  }
}

export function timeStageDecayMultiplier(value) {
  const stage = String(value || 'raw').trim().toLowerCase();
  return {
    raw: 1,
    digest: 0.75,
    pattern: 0.5,
    dormant: 0.25,
    forgotten: 0,
    decayed: 0.25,
  }[stage] ?? 1;
}

function vaultRowTimestamp(row = {}, meta = {}) {
  const raw = meta.createdAt || meta.payload?.createdAt || row.updated_at || row.created_at;
  const timestamp = new Date(String(raw || 0)).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function compareVaultRows(left, right) {
  const leftMeta = parseVaultMeta(left.meta);
  const rightMeta = parseVaultMeta(right.meta);
  const timeDelta = vaultRowTimestamp(right, rightMeta) - vaultRowTimestamp(left, leftMeta);
  if (timeDelta !== 0) return timeDelta;
  return String(right.id || '').localeCompare(String(left.id || ''), 'en', { numeric: true });
}

function vaultValidationState(row = {}, meta = {}) {
  return String(row.validation_state || meta.libraryCoords?.validation_state || 'unverified')
    .trim()
    .toLowerCase();
}

function normalizeMergedWeights(weights = {}, fallback = {}) {
  const entries = Object.entries(weights).filter(([, value]) => Number.isFinite(Number(value)) && Number(value) >= 0);
  const total = entries.reduce((sum, [, value]) => sum + Number(value), 0);
  if (total <= 0) return normalizeWeights(fallback);
  return Object.fromEntries(entries.map(([key, value]) => [key, Number(value) / total]));
}

export function buildVaultRegimeWeights(rows = [], requestedRegime = null) {
  const requested = requestedRegime ? normalizeRegime(requestedRegime) : null;
  const mapDefinitions = {
    fusionWeights: BASE_FUSION_WEIGHTS,
    signalWeights: BASE_SIGNAL_WEIGHTS,
    universeWeights: REGIME_AXIS_WEIGHTS,
  };
  const selectedByRegime = new Map();
  const rejectedByRegime = new Map();
  const rowMetaByRegime = new Map();

  for (const row of [...(rows || [])].sort(compareVaultRows)) {
    const meta = parseVaultMeta(row.meta);
    if (meta.constitutionAllowed === false) continue;
    if (vaultValidationState(row, meta) !== 'validated') continue;
    const payload = parseVaultMeta(meta.payload || {});
    const regime = normalizeRegime(payload.regime || 'RANGING');
    if (requested && regime !== requested) continue;
    if (payload.weightUnit && payload.weightUnit !== 'ratio_0_1') continue;
    const symbol = String(payload.symbol || `__REGIME_${regime}__`);
    if (symbol !== `__REGIME_${regime}__`) continue;
    const timeStage = row.time_stage || meta.libraryCoords?.time_stage || 'raw';
    const decayMultiplier = timeStageDecayMultiplier(timeStage);
    if (!selectedByRegime.has(regime)) selectedByRegime.set(regime, {});
    if (!rejectedByRegime.has(regime)) rejectedByRegime.set(regime, []);
    const selected = selectedByRegime.get(regime);

    for (const [mapName, bases] of Object.entries(mapDefinitions)) {
      const base = bases[regime] || bases.RANGING || {};
      const contract = sanitizeLunaLearnedBiasWeightMap(payload[mapName], {
        allowedKeys: Object.keys(base),
      });
      for (const rejected of contract.rejected) {
        rejectedByRegime.get(regime).push({
          map: mapName,
          factor: rejected.key,
          sourceId: String(row.id || ''),
          reason: rejected.reason,
        });
      }
      if (!selected[mapName]) selected[mapName] = {};
      for (const [factor, value] of Object.entries(contract.weights)) {
        if (selected[mapName][factor]) continue;
        const baseValue = Number(base[factor] || 0);
        selected[mapName][factor] = {
          value,
          decayedValue: baseValue + (Number(value) - baseValue) * decayMultiplier,
          sourceId: String(row.id || ''),
          updatedAt: new Date(vaultRowTimestamp(row, meta)).toISOString(),
          timeStage: String(timeStage),
          decayMultiplier,
        };
        if (!rowMetaByRegime.has(regime)) rowMetaByRegime.set(regime, payload);
      }
    }
  }

  const output = [];
  for (const [regime, selected] of selectedByRegime.entries()) {
    const hasSelectedFactor = Object.values(selected)
      .some((factorMap) => Object.keys(factorMap || {}).length > 0);
    if (!hasSelectedFactor) continue;
    const mergedMaps = {};
    for (const [mapName, bases] of Object.entries(mapDefinitions)) {
      const base = bases[regime] || bases.RANGING || {};
      mergedMaps[mapName] = normalizeMergedWeights(Object.fromEntries(
        Object.keys(base).map((factor) => [
          factor,
          selected[mapName]?.[factor]?.decayedValue ?? base[factor],
        ]),
      ), base);
    }
    const payload = rowMetaByRegime.get(regime) || {};
    const selectedFactors = selected;
    const updatedAt = Object.values(selectedFactors)
      .flatMap((factorMap) => Object.values(factorMap || {}))
      .map((factor) => factor.updatedAt)
      .sort()
      .at(-1) || null;
    output.push({
      regime,
      ...mergedMaps,
      winRate: payload.winRate ?? null,
      profitFactor: payload.profitFactor ?? null,
      performanceMetric: payload.performanceMetric ?? null,
      totalTrades: payload.totalTrades ?? null,
      updatedAt,
      source: 'sigma_vault',
      selectedFactors,
      rejectedFactors: rejectedByRegime.get(regime) || [],
    });
  }
  return output.sort((left, right) => left.regime.localeCompare(right.regime));
}

function mapSnapshotRows(rows = []) {
  return (rows || []).map((r) => ({
    regime: r.regime,
    fusionWeights: r.fusion_weights || BASE_FUSION_WEIGHTS[r.regime],
    signalWeights: r.signal_weights || BASE_SIGNAL_WEIGHTS[r.regime],
    universeWeights: r.universe_weights || REGIME_AXIS_WEIGHTS[r.regime] || REGIME_AXIS_WEIGHTS.RANGING,
    winRate: r.win_rate,
    profitFactor: r.profit_factor,
    performanceMetric: r.performance_metric,
    totalTrades: r.total_trades,
    updatedAt: r.created_at,
    source: 'snapshot_fallback',
  }));
}

export async function getLatestSnapshotRegimeWeights(regime = null, options = {}) {
  const normalizedRegime = regime ? normalizeRegime(regime) : null;
  const snapshotRowsProvider = options.snapshotRowsProvider || (async () => query(
    `SELECT DISTINCT ON (regime)
       id, regime, fusion_weights, signal_weights, universe_weights,
       win_rate, profit_factor, performance_metric, total_trades, created_at
     FROM investment.luna_regime_weight_snapshots
     WHERE ($1::text IS NULL OR regime = $1)
     ORDER BY regime, created_at DESC, id DESC`,
    [normalizedRegime],
  ));
  const rows = await snapshotRowsProvider(normalizedRegime).catch(() => []);
  return mapSnapshotRows(rows);
}

export const LUNA_LEARNED_BIAS_SNAPSHOT_FALLBACK_ENABLED_KEY = 'LUNA_LEARNED_BIAS_SNAPSHOT_FALLBACK_ENABLED';

function isSnapshotFallbackEnabled(options = {}) {
  if (options.allowSnapshotFallback === true) return true;
  return String((options.env || process.env)?.[LUNA_LEARNED_BIAS_SNAPSHOT_FALLBACK_ENABLED_KEY] || '').toLowerCase() === 'true';
}

export async function getLatestRegimeWeights(regime = null, options = {}) {
  const normalizedRegime = regime ? normalizeRegime(regime) : null;
  const vaultRowsProvider = options.vaultRowsProvider || fetchLunaLearnedBiasVaultRows;
  const vaultRows = await vaultRowsProvider(normalizedRegime).catch(() => []);
  const vaultWeights = buildVaultRegimeWeights(vaultRows, normalizedRegime);
  if (normalizedRegime && vaultWeights.length > 0) return vaultWeights;
  const knownRegimes = Object.keys(BASE_FUSION_WEIGHTS);
  const vaultRegimes = new Set(vaultWeights.map((row) => row.regime));
  if (!normalizedRegime && knownRegimes.every((key) => vaultRegimes.has(key))) return vaultWeights;
  if (!isSnapshotFallbackEnabled(options)) return vaultWeights;
  const snapshotWeights = await getLatestSnapshotRegimeWeights(normalizedRegime, options);
  if (vaultWeights.length === 0) return snapshotWeights;
  return [
    ...vaultWeights,
    ...snapshotWeights.filter((row) => !vaultRegimes.has(row.regime)),
  ].sort((left, right) => left.regime.localeCompare(right.regime));
}

export const _testOnly = {
  buildAdaptiveRegimeDataset,
  buildWeightDiagnostics,
  buildVaultRegimeWeights,
  countConsecutiveRecentStallDays,
  computeRegimePerformance,
  fetchRegimeTradeStats,
  maxMapDelta,
  normalizeRegime,
  parseAdaptiveWindows,
  summarizeLearnerStall,
  timeStageDecayMultiplier,
};

export default {
  runRegimeWeightLearner,
  getLatestRegimeWeights,
  getLatestSnapshotRegimeWeights,
  BASE_FUSION_WEIGHTS,
  BASE_SIGNAL_WEIGHTS,
  LUNA_LEARNED_BIAS_SNAPSHOT_FALLBACK_ENABLED_KEY,
  REGIME_WEIGHT_LEARNER_ENABLED_KEY,
  DEFAULT_WEIGHT_LEARNER_LOOKBACK_DAYS,
  DEFAULT_WEIGHT_LEARNER_ADAPTIVE_WINDOWS,
  DEFAULT_WEIGHT_LEARNER_MIN_TRADES,
  _testOnly,
};
