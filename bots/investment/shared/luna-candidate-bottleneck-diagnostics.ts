// @ts-nocheck
/**
 * Shadow-only candidate bottleneck diagnostics.
 *
 * This layer turns repeated candidate failures into explicit evidence. It does
 * not filter, trade, or mutate live state; downstream stages can inspect the
 * shadow rows before changing promotion or routing policy.
 */

import { query, run } from './db/core.ts';
import { exchangeForLunaPhase2Market, normalizeLunaPhase2Market, normalizeLunaPhase2Symbol } from './luna-weight-vector.ts';

function n(value: any, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: any, min = 0, max = 1, fallback = 0) {
  return Math.max(min, Math.min(max, n(value, fallback)));
}

function round(value: any, digits = 4) {
  return Number(n(value, 0).toFixed(digits));
}

function parseJsonMaybe(value: any, fallback: any = {}) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function isTrue(value: any) {
  return value === true || String(value).toLowerCase() === 'true';
}

function ageHours(value: any) {
  if (!value) return Infinity;
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return Infinity;
  return Math.max(0, (Date.now() - ts) / 3600_000);
}

function isPredictivePass(decision: any) {
  return ['fire', 'pass', 'pass_prediction', 'pass_backtest'].includes(String(decision || '').toLowerCase());
}

function isPredictiveBlocked(decision: any, blockedReason: any) {
  const raw = String(decision || '').toLowerCase();
  return raw.includes('block') || raw.includes('would_block') || Boolean(blockedReason);
}

function actionFromReasons(reasons: string[], input: any = {}) {
  const predictive = input.predictive || {};
  const communitySources = n(input.community?.source_count, 0) + n(input.community?.market_source_count, 0);
  const predictiveScore = n(predictive.score, 0);
  const hasFreshBacktestQualityIssue = !reasons.includes('backtest_missing_or_stale')
    && (
      reasons.includes('backtest_unhealthy_or_would_block')
      || reasons.includes('sharpe_negative')
      || reasons.includes('win_rate_low')
      || reasons.includes('drawdown_high')
    );
  const severeUnconfirmedBacktestFailure = hasFreshBacktestQualityIssue
    && reasons.includes('predictive_blocked')
    && predictiveScore < 0.4
    && communitySources < 2;
  if (hasFreshBacktestQualityIssue && !severeUnconfirmedBacktestFailure) {
    return 'strategy_enhancement_shadow';
  }
  if (severeUnconfirmedBacktestFailure) {
    return 'quarantine_candidate_shadow';
  }
  if (reasons.some((reason) => reason.includes('missing') || reason.includes('stale'))) {
    return 'refresh_evidence';
  }
  if (reasons.includes('predictive_coverage_low')) {
    return 'predictive_refresh';
  }
  if (reasons.includes('community_coverage_low')) {
    return 'community_evidence_refresh';
  }
  if (reasons.includes('sharpe_negative') || reasons.includes('win_rate_low')) {
    if (isPredictivePass(predictive.decision) && predictiveScore >= 0.55 && communitySources >= 2) {
      return 'strategy_enhancement_shadow';
    }
    return 'quarantine_candidate_shadow';
  }
  if (reasons.includes('drawdown_high') || reasons.includes('backtest_unhealthy_or_would_block')) {
    return 'strategy_enhancement_shadow';
  }
  if (reasons.includes('predictive_blocked')) {
    return 'predictive_refresh';
  }
  return 'monitor_pass_candidate';
}

function refreshCommandFor(action: string, reasons: string[], row: any = {}) {
  const market = normalizeLunaPhase2Market(row.market || row.candidate?.market);
  if (action === 'strategy_enhancement_shadow') {
    return `npm --prefix bots/investment run -s runtime:luna-phase4-strategy-enhancement-shadow -- --json --dry-run --market=${market}`;
  }
  if (reasons.some((reason) => reason.startsWith('backtest_') || reason === 'sharpe_negative' || reason === 'win_rate_low' || reason === 'drawdown_high')) {
    return `npm --prefix bots/investment run -s runtime:luna-candidate-backtest-refresh -- --json --force --market=${market}`;
  }
  if (reasons.some((reason) => reason.startsWith('predictive_'))) {
    return `npm --prefix bots/investment run -s runtime:luna-predictive-evidence-refresh -- --json --market=${market}`;
  }
  if (reasons.includes('community_coverage_low')) {
    return `npm --prefix bots/investment run -s runtime:luna-community-evidence-refresh -- --json`;
  }
  return `npm --prefix bots/investment run -s runtime:luna-candidate-bottleneck-diagnostics -- --json --dry-run --market=${market}`;
}

function severityFrom(action: string, reasons: string[]) {
  if (action === 'monitor_pass_candidate') return 'pass';
  if (action === 'quarantine_candidate_shadow') return 'blocker';
  if (action === 'refresh_evidence') return 'review';
  if (reasons.includes('predictive_blocked') || reasons.includes('backtest_unhealthy_or_would_block')) return 'review';
  return 'observe';
}

function penaltyFromReasons(reasons: string[], action: string) {
  if (action === 'monitor_pass_candidate') return 0;
  let penalty = 0.12;
  if (reasons.includes('sharpe_negative')) penalty += 0.22;
  if (reasons.includes('win_rate_low')) penalty += 0.18;
  if (reasons.includes('backtest_unhealthy_or_would_block')) penalty += 0.16;
  if (reasons.includes('predictive_blocked')) penalty += 0.14;
  if (reasons.includes('predictive_coverage_low')) penalty += 0.10;
  if (reasons.includes('community_coverage_low')) penalty += 0.08;
  if (action === 'quarantine_candidate_shadow') penalty += 0.12;
  return round(clamp(penalty, 0, 0.75, 0), 4);
}

export async function ensureLunaCandidateBottleneckSchema() {
  await run(`
    CREATE TABLE IF NOT EXISTS luna_candidate_bottleneck_shadow (
      id                            BIGSERIAL PRIMARY KEY,
      symbol                        TEXT NOT NULL,
      market                        TEXT NOT NULL,
      exchange                      TEXT NOT NULL,
      severity                      TEXT NOT NULL DEFAULT 'observe',
      recommended_action            TEXT NOT NULL,
      candidate_score               DOUBLE PRECISION DEFAULT 0,
      backtest_status               TEXT,
      predictive_decision           TEXT,
      community_sources             INTEGER DEFAULT 0,
      candidate_selection_penalty   DOUBLE PRECISION DEFAULT 0,
      shadow_only                   BOOLEAN DEFAULT TRUE,
      live_mutation                 BOOLEAN DEFAULT FALSE,
      reasons                       JSONB DEFAULT '[]'::jsonb,
      evidence                      JSONB DEFAULT '{}'::jsonb,
      observed_at                   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_candidate_bottleneck_symbol ON luna_candidate_bottleneck_shadow(symbol, market, observed_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_candidate_bottleneck_action ON luna_candidate_bottleneck_shadow(recommended_action, observed_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_candidate_bottleneck_observed ON luna_candidate_bottleneck_shadow(observed_at DESC)`);
}

export function fixtureCandidateBottleneckInputs() {
  const now = new Date().toISOString();
  return [
    {
      candidate: { symbol: 'BTC/USDT', market: 'crypto', score: 0.88, source: 'fixture', discovered_at: now },
      backtest: { fresh: true, healthy: true, sharpe: 1.1, max_drawdown: 9, win_rate: 54, gate_status: 'pass', last_backtest_at: now },
      predictive: { decision: 'fire', score: 0.74, component_coverage: 1, created_at: now },
      community: { avg_score: 0.35, event_count: 4, source_count: 3, market_event_count: 12, market_source_count: 8, last_seen_at: now },
    },
    {
      candidate: { symbol: 'NEG/USDT', market: 'crypto', score: 0.79, source: 'fixture', discovered_at: now },
      backtest: { fresh: true, healthy: false, would_block: true, sharpe: -0.7, max_drawdown: 18, win_rate: 24, gate_status: 'would_block_unhealthy', last_backtest_at: now },
      predictive: { decision: 'block_backtest_gate', score: 0.32, component_coverage: 1, blocked_reason: 'backtest_unhealthy', created_at: now },
      community: { avg_score: 0.12, event_count: 1, source_count: 1, market_event_count: 4, market_source_count: 4, last_seen_at: now },
    },
    {
      candidate: { symbol: 'ALPHA/USDT', market: 'crypto', score: 0.82, source: 'fixture', discovered_at: now },
      backtest: { fresh: true, healthy: false, would_block: true, sharpe: -0.2, max_drawdown: 14, win_rate: 29, gate_status: 'would_block_unhealthy', last_backtest_at: now },
      predictive: { decision: 'fire', score: 0.68, component_coverage: 1, created_at: now },
      community: { avg_score: 0.41, event_count: 3, source_count: 3, market_event_count: 8, market_source_count: 6, last_seen_at: now },
    },
    {
      candidate: { symbol: 'MISS/USDT', market: 'crypto', score: 0.71, source: 'fixture', discovered_at: now },
      backtest: null,
      predictive: { decision: null, score: null, component_coverage: 0, created_at: null },
      community: { avg_score: null, event_count: 0, source_count: 0, market_event_count: 0, market_source_count: 0, last_seen_at: null },
    },
  ];
}

export function buildLunaCandidateBottleneckRows(inputs: any[] = [], options: any = {}) {
  const staleBacktestHours = n(options.staleBacktestHours, 24);
  const stalePredictiveHours = n(options.stalePredictiveHours, 24 * 7);
  return (inputs || []).map((input) => {
    const candidate = input.candidate || input;
    const backtest = input.backtest || {};
    const predictive = input.predictive || {};
    const community = input.community || {};
    const symbol = normalizeLunaPhase2Symbol(candidate.symbol);
    const market = normalizeLunaPhase2Market(candidate.market || input.market);
    const exchange = candidate.exchange || exchangeForLunaPhase2Market(market);
    const reasons: string[] = [];

    const backtestFresh = isTrue(backtest.fresh) && ageHours(backtest.last_backtest_at) <= staleBacktestHours;
    const backtestHealthy = isTrue(backtest.healthy);
    const backtestWouldBlock = isTrue(backtest.would_block) || isTrue(backtest.wouldBlock);
    const sharpe = n(backtest.sharpe, 0);
    const winRate = n(backtest.win_rate ?? backtest.winRate, 0);
    const drawdown = Math.abs(n(backtest.max_drawdown ?? backtest.maxDrawdown, 0));

    if (!backtest || Object.keys(backtest).length === 0 || !backtestFresh) reasons.push('backtest_missing_or_stale');
    if (backtest && Object.keys(backtest).length > 0 && (!backtestHealthy || backtestWouldBlock || String(backtest.gate_status || '').startsWith('would_block'))) reasons.push('backtest_unhealthy_or_would_block');
    if (backtest && Object.keys(backtest).length > 0 && sharpe < 0) reasons.push('sharpe_negative');
    if (backtest && Object.keys(backtest).length > 0 && backtest.win_rate != null && winRate < 30) reasons.push('win_rate_low');
    if (backtest && Object.keys(backtest).length > 0 && drawdown > 30) reasons.push('drawdown_high');

    const predictiveDecision = predictive.decision || null;
    const predictiveCoverage = clamp(predictive.component_coverage, 0, 1, 0);
    if (!predictiveDecision || ageHours(predictive.created_at) > stalePredictiveHours) reasons.push('predictive_missing_or_stale');
    if (predictiveDecision && isPredictiveBlocked(predictiveDecision, predictive.blocked_reason)) reasons.push('predictive_blocked');
    if (predictiveDecision && predictiveCoverage < 0.75) reasons.push('predictive_coverage_low');

    const communitySources = n(community.source_count, 0) + n(community.market_source_count, 0);
    const communityFresh = ageHours(community.last_seen_at || community.market_last_seen_at) <= 24;
    if (communitySources < 2 || !communityFresh) reasons.push('community_coverage_low');

    const uniqueReasons = [...new Set(reasons)];
    const recommendedAction = actionFromReasons(uniqueReasons, input);
    const severity = severityFrom(recommendedAction, uniqueReasons);
    const candidateSelectionPenalty = penaltyFromReasons(uniqueReasons, recommendedAction);
    const communityEvidenceCount24h = n(community.event_count ?? community.eventCount, 0) + n(community.market_event_count ?? community.marketEventCount, 0);
    const communitySourceCount24h = communitySources;
    const primaryBlocker = uniqueReasons[0] || null;
    const recommendedRefreshCommand = refreshCommandFor(recommendedAction, uniqueReasons, { market, candidate });

    return {
      ok: true,
      symbol,
      market,
      exchange,
      severity,
      recommendedAction,
      recommendedRefreshCommand,
      candidateScore: round(candidate.score, 4),
      backtestStatus: backtest.gate_status || (backtestFresh && backtestHealthy ? 'pass' : 'unknown'),
      backtestFresh,
      backtestGateStatus: backtest.gate_status || (backtestFresh && backtestHealthy ? 'pass' : 'unknown'),
      predictiveDecision,
      communitySources,
      communityEvidenceCount24h,
      communitySourceCount24h,
      primaryBlocker,
      candidateSelectionPenalty,
      reasons: uniqueReasons,
      shadowOnly: true,
      liveMutation: false,
      evidence: {
        phase: 'luna_candidate_quality_bottleneck_shadow',
        source: 'luna_candidate_bottleneck_diagnostics',
        candidate,
        backtest,
        predictive,
        community,
        trace: {
          backtestFresh,
          backtestGateStatus: backtest.gate_status || (backtestFresh && backtestHealthy ? 'pass' : 'unknown'),
          predictiveDecision,
          communityEvidenceCount24h,
          communitySourceCount24h,
          primaryBlocker,
          recommendedRefreshCommand,
        },
        thresholds: {
          staleBacktestHours,
          stalePredictiveHours,
          minPredictiveCoverage: 0.75,
          minCommunitySources: 2,
        },
        liveMutation: false,
      },
    };
  });
}

export async function loadLunaCandidateBottleneckInputs({ limit = 50, market = null } = {}) {
  const params: any[] = [];
  const requestedMarket = String(market || '').trim().toLowerCase();
  const normalizedMarket = requestedMarket && requestedMarket !== 'all'
    ? normalizeLunaPhase2Market(requestedMarket)
    : null;
  const marketWhere = normalizedMarket ? `AND market = $${params.push(normalizedMarket)}` : '';
  const perMarketLimit = Math.max(1, Math.ceil(Number(limit || 50) / 3));
  const marketRankWhere = normalizedMarket
    ? ''
    : `WHERE market_rank <= $${params.push(perMarketLimit)}`;
  params.push(limit);
  const rows = await query(`
    WITH symbol_community AS (
      SELECT symbol, market,
             (SUM(score * GREATEST(0.05, COALESCE(source_quality, 0.5)) * GREATEST(0.2, COALESCE(freshness_score, 1.0)))
              / NULLIF(SUM(GREATEST(0.05, COALESCE(source_quality, 0.5)) * GREATEST(0.2, COALESCE(freshness_score, 1.0))), 0))::double precision AS avg_score,
             COUNT(*)::int AS event_count,
             COUNT(DISTINCT source_name)::int AS source_count,
             AVG(source_quality)::double precision AS avg_source_quality,
             MAX(created_at) AS last_seen_at,
             MAX(CASE WHEN COALESCE((raw_ref->'botNoise'->>'score')::double precision, 0) > 0.5 THEN 1 ELSE 0 END)::int AS bot_noise_flag,
             MAX(CASE WHEN COALESCE((raw_ref->'hypeSpike'->>'detected')::boolean, false) THEN 1 ELSE 0 END)::int AS hype_spike_flag
        FROM external_evidence_events
       WHERE source_type = 'community'
         AND created_at >= NOW() - INTERVAL '24 hours'
         AND symbol IS NOT NULL
         AND source_name <> 'community_candidate_gap'
         AND COALESCE(source_name, '') <> 'cryptopanic_news'
         AND COALESCE((raw_ref->>'missing_data')::boolean, false) = false
       GROUP BY symbol, market
    ),
    market_community AS (
      SELECT market,
             (SUM(score * GREATEST(0.05, COALESCE(source_quality, 0.5)) * GREATEST(0.2, COALESCE(freshness_score, 1.0)))
              / NULLIF(SUM(GREATEST(0.05, COALESCE(source_quality, 0.5)) * GREATEST(0.2, COALESCE(freshness_score, 1.0))), 0))::double precision AS market_avg_score,
             COUNT(*)::int AS market_event_count,
             COUNT(DISTINCT source_name)::int AS market_source_count,
             AVG(source_quality)::double precision AS market_avg_quality,
             MAX(created_at) AS market_last_seen_at
        FROM external_evidence_events
       WHERE source_type = 'community'
         AND created_at >= NOW() - INTERVAL '24 hours'
         AND symbol IS NULL
         AND source_name <> 'community_candidate_gap'
         AND COALESCE(source_name, '') <> 'cryptopanic_news'
         AND COALESCE((raw_ref->>'missing_data')::boolean, false) = false
       GROUP BY market
    ),
    latest_predictive AS (
      SELECT DISTINCT ON (symbol, market)
             symbol, market, decision, score, threshold, component_coverage,
             blocked_reason, created_at
        FROM predictive_validation_log
       WHERE created_at >= NOW() - INTERVAL '7 days'
       ORDER BY symbol, market, created_at DESC
    ),
    active_candidates AS (
      SELECT DISTINCT ON (symbol, market)
             symbol, market, score, source, discovered_at, expires_at, reason, raw_data
        FROM candidate_universe
       WHERE expires_at > NOW()
         ${marketWhere}
       ORDER BY symbol, market, score DESC, discovered_at DESC
    ),
    balanced_candidates AS (
      SELECT *,
             ROW_NUMBER() OVER (PARTITION BY market ORDER BY score DESC, discovered_at DESC) AS market_rank
        FROM active_candidates
    ),
    selected_candidates AS (
      SELECT *
        FROM balanced_candidates
        ${marketRankWhere}
    )
    SELECT cu.symbol, cu.market, cu.score::double precision AS candidate_score, cu.source,
           cu.discovered_at, cu.expires_at, cu.reason, cu.raw_data,
           cbs.fresh, cbs.healthy, cbs.sharpe, cbs.max_drawdown, cbs.win_rate,
           cbs.last_backtest_at, cbs.gate_status, cbs.would_block, cbs.block_reasons,
           lp.decision AS predictive_decision, lp.score AS predictive_score,
           lp.threshold AS predictive_threshold, lp.component_coverage,
           lp.blocked_reason AS predictive_blocked_reason, lp.created_at AS predictive_created_at,
           symbol_community.avg_score AS community_avg_score,
           symbol_community.event_count AS community_event_count,
           symbol_community.source_count AS community_source_count,
           symbol_community.avg_source_quality AS community_avg_source_quality,
           symbol_community.last_seen_at AS community_last_seen_at,
           symbol_community.bot_noise_flag AS community_bot_noise_flag,
           symbol_community.hype_spike_flag AS community_hype_spike_flag,
           market_community.market_avg_score AS community_market_avg_score,
           market_community.market_event_count AS community_market_event_count,
           market_community.market_source_count AS community_market_source_count,
           market_community.market_avg_quality AS community_market_avg_quality,
           market_community.market_last_seen_at AS community_market_last_seen_at
      FROM selected_candidates cu
      LEFT JOIN candidate_backtest_status cbs
        ON cbs.symbol = cu.symbol AND cbs.market = cu.market
      LEFT JOIN latest_predictive lp
        ON lp.symbol = cu.symbol AND lp.market = cu.market
      LEFT JOIN symbol_community
        ON symbol_community.symbol = cu.symbol AND symbol_community.market = cu.market
      LEFT JOIN market_community
        ON market_community.market = cu.market
     ORDER BY cu.score DESC, cu.discovered_at DESC
     LIMIT $${params.length}
  `, params).catch(() => []);

  return rows.map((row) => ({
    candidate: {
      symbol: row.symbol,
      market: row.market,
      score: row.candidate_score,
      source: row.source,
      discovered_at: row.discovered_at,
      expires_at: row.expires_at,
      reason: row.reason,
      raw_data: parseJsonMaybe(row.raw_data, {}),
    },
    backtest: {
      fresh: row.fresh,
      healthy: row.healthy,
      sharpe: row.sharpe,
      max_drawdown: row.max_drawdown,
      win_rate: row.win_rate,
      last_backtest_at: row.last_backtest_at,
      gate_status: row.gate_status,
      would_block: row.would_block,
      block_reasons: parseJsonMaybe(row.block_reasons, []),
    },
    predictive: {
      decision: row.predictive_decision,
      score: row.predictive_score,
      threshold: row.predictive_threshold,
      component_coverage: row.component_coverage,
      blocked_reason: row.predictive_blocked_reason,
      created_at: row.predictive_created_at,
    },
    community: {
      avg_score: row.community_avg_score,
      event_count: row.community_event_count,
      source_count: row.community_source_count,
      avg_source_quality: row.community_avg_source_quality,
      last_seen_at: row.community_last_seen_at,
      market_avg_score: row.community_market_avg_score,
      market_event_count: row.community_market_event_count,
      market_source_count: row.community_market_source_count,
      market_avg_quality: row.community_market_avg_quality,
      market_last_seen_at: row.community_market_last_seen_at,
      bot_noise_score: row.community_bot_noise_flag ? 0.6 : 0,
      hype_spike: row.community_hype_spike_flag === 1,
    },
  }));
}

export async function insertLunaCandidateBottleneckShadow(row: any = {}) {
  await run(`
    INSERT INTO luna_candidate_bottleneck_shadow
      (symbol, market, exchange, severity, recommended_action, candidate_score,
       backtest_status, predictive_decision, community_sources,
       candidate_selection_penalty, shadow_only, live_mutation, reasons, evidence)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,false,$11::jsonb,$12::jsonb)
  `, [
    row.symbol,
    row.market,
    row.exchange,
    row.severity,
    row.recommendedAction,
    row.candidateScore,
    row.backtestStatus,
    row.predictiveDecision,
    row.communitySources,
    row.candidateSelectionPenalty,
    JSON.stringify(row.reasons || []),
    JSON.stringify(row.evidence || {}),
  ]);
}
