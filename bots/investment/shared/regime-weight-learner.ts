// @ts-nocheck
// regime-weight-learner.ts — 체제별 fusion + signal 가중치 DB 기반 학습
// 수익률 기반 밴딧(Bandit) 방식으로 4 체제별 가중치를 점진적 개선
// 매일 07:00 실행 (ai.luna.weight-adaptive-tuner-daily-0700.plist)
// 결과 → investment.luna_regime_weight_snapshots 테이블 저장

import { query } from './db/core.ts';
import { persistAdaptedWeights, retrieveAdaptedWeights } from './ta-weight-adaptive-tuner.ts';

// ─── 환경 게이트 ──────────────────────────────────────────────────────────────
function boolEnv(name, fallback = false) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function numEnv(name, fallback = 0) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : fallback;
}

export const REGIME_WEIGHT_LEARNER_ENABLED_KEY = 'LUNA_REGIME_WEIGHT_LEARNER_ENABLED';

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
  TRENDING_BEAR:  { momentum: 0.15, breakout: 0.15, mean_reversion: 0.30, defensive: 0.40 },
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

async function fetchRegimeTradeStats(days = 7) {
  // trade_journal: exit_time(ms), is_paper, pnl, regime, signal_type, market
  const rows = await query(
    `SELECT
       COALESCE(tj.regime, 'RANGING')         AS regime,
       COALESCE(tj.signal_type, 'momentum')   AS signal_type,
       COALESCE(tj.market, 'crypto')           AS market,
       COUNT(*)                               AS total_trades,
       COUNT(*) FILTER (WHERE COALESCE(tj.pnl, 0) > 0) AS win_trades,
       AVG(COALESCE(tj.pnl, 0))               AS avg_pnl,
       AVG(COALESCE(tj.pnl_pct, 0))           AS avg_pnl_pct,
       SUM(CASE WHEN COALESCE(tj.pnl, 0) > 0 THEN COALESCE(tj.pnl, 0) ELSE 0 END) AS gross_profit,
       SUM(CASE WHEN COALESCE(tj.pnl, 0) < 0 THEN ABS(COALESCE(tj.pnl, 0)) ELSE 0 END) AS gross_loss
     FROM investment.trade_journal tj
     WHERE tj.exit_time IS NOT NULL
       AND NOT COALESCE(tj.is_paper, false)
       AND to_timestamp(tj.exit_time / 1000.0) >= NOW() - ($1 || ' days')::interval
     GROUP BY COALESCE(tj.regime, 'RANGING'), COALESCE(tj.signal_type, 'momentum'), COALESCE(tj.market, 'crypto')
     ORDER BY total_trades DESC`,
    [days],
  ).catch(() => []);

  return rows || [];
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

// ─── DB 스냅샷 저장 ──────────────────────────────────────────────────────────

async function saveWeightSnapshot(snapshot) {
  await query(
    `INSERT INTO investment.luna_regime_weight_snapshots
       (regime, fusion_weights, signal_weights, win_rate, profit_factor, total_trades, learn_rate, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT DO NOTHING`,
    [
      snapshot.regime,
      JSON.stringify(snapshot.fusionWeights),
      JSON.stringify(snapshot.signalWeights),
      snapshot.winRate,
      snapshot.profitFactor,
      snapshot.totalTrades,
      snapshot.learnRate,
    ],
  ).catch((err) => {
    console.warn(`[RegimeWeightLearner] DB 저장 실패 (테이블 없음 무시): ${err?.message}`);
  });
}

// ─── 메인 학습 함수 ──────────────────────────────────────────────────────────

export async function runRegimeWeightLearner(options = {}) {
  const enabled = boolEnv(REGIME_WEIGHT_LEARNER_ENABLED_KEY, true);
  if (!enabled) {
    console.log('[RegimeWeightLearner] 비활성화 (LUNA_REGIME_WEIGHT_LEARNER_ENABLED=false)');
    return { skipped: true, reason: 'disabled' };
  }

  const days = numEnv('LUNA_WEIGHT_LEARNER_LOOKBACK_DAYS', 7) || options.days || 7;
  const learnRate = Math.max(0.01, Math.min(0.20, numEnv('LUNA_TA_WEIGHT_ADAPTIVE_LEARN_RATE', 0.08)));

  console.log(`[RegimeWeightLearner] 학습 시작 — 기간: ${days}일, 학습률: ${learnRate}`);

  // 1. DB에서 거래 이력 조회
  const rows = await fetchRegimeTradeStats(days);
  console.log(`[RegimeWeightLearner] 거래 이력: ${rows.length}행`);

  // 2. 체제별 성과 계산
  const performance = computeRegimePerformance(rows);

  // 3. fusion 가중치 조정
  const updatedFusion = adjustWeightsFromPerformance(BASE_FUSION_WEIGHTS, performance, learnRate);

  // 4. signal 가중치 조정
  const updatedSignal = adjustSignalWeightsFromPerformance(BASE_SIGNAL_WEIGHTS, performance, learnRate);

  // 5. TA 지표 가중치도 업데이트 (ta-weight-adaptive-tuner와 동기화)
  for (const [regime, _] of Object.entries(updatedFusion)) {
    const taWeights = retrieveAdaptedWeights(regime);
    if (performance[regime]?.totalTrades >= 3) {
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

  // 6. DB 스냅샷 저장
  const snapshots = [];
  for (const [regime, fusionWeights] of Object.entries(updatedFusion)) {
    const perf = performance[regime] || {};
    const snapshot = {
      regime,
      fusionWeights,
      signalWeights: updatedSignal[regime] || BASE_SIGNAL_WEIGHTS[regime],
      winRate: perf.winRate || 0,
      profitFactor: perf.profitFactor || 0,
      totalTrades: perf.totalTrades || 0,
      learnRate,
    };
    snapshots.push(snapshot);
    if (!options.dryRun) await saveWeightSnapshot(snapshot);
  }

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
    days,
    learnRate,
    regimesUpdated: snapshots.length,
    snapshots,
    performance,
  };
}

// ─── 현재 학습된 가중치 조회 ────────────────────────────────────────────────

export async function getLatestRegimeWeights(regime = null) {
  const rows = await query(
    `SELECT DISTINCT ON (regime)
       regime, fusion_weights, signal_weights, win_rate, profit_factor, total_trades, created_at
     FROM investment.luna_regime_weight_snapshots
     WHERE ($1::text IS NULL OR regime = $1)
     ORDER BY regime, created_at DESC`,
    [regime ? normalizeRegime(regime) : null],
  ).catch(() => []);

  return (rows || []).map((r) => ({
    regime: r.regime,
    fusionWeights: r.fusion_weights || BASE_FUSION_WEIGHTS[r.regime],
    signalWeights: r.signal_weights || BASE_SIGNAL_WEIGHTS[r.regime],
    winRate: r.win_rate,
    profitFactor: r.profit_factor,
    totalTrades: r.total_trades,
    updatedAt: r.created_at,
  }));
}

export default {
  runRegimeWeightLearner,
  getLatestRegimeWeights,
  BASE_FUSION_WEIGHTS,
  BASE_SIGNAL_WEIGHTS,
  REGIME_WEIGHT_LEARNER_ENABLED_KEY,
};
