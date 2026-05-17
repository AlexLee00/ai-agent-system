// @ts-nocheck
/**
 * Shadow-only governance for Luna candidate quality.
 *
 * Diagnostics explain what is wrong with a candidate. This layer turns those
 * diagnostics into durable shadow actions: prioritize stale evidence refresh,
 * route repairable strategies to shadow tuning, and cool down repeatedly bad
 * candidates so replacement discovery/backtesting can get compute budget.
 */

import { query, run } from './db/core.ts';
import {
  exchangeForLunaPhase2Market,
  normalizeLunaPhase2Market,
  normalizeLunaPhase2Symbol,
  normalizeLunaPhase2Symbols,
} from './luna-weight-vector.ts';

function n(value: any, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function addHours(date: Date, hours: number) {
  return new Date(date.getTime() + Math.max(1, Number(hours || 1)) * 3600_000).toISOString();
}

function reasonList(row: any = {}) {
  return Array.isArray(row.reasons) ? row.reasons.map((reason) => String(reason)) : [];
}

function hasReason(row: any = {}, reason: string) {
  return reasonList(row).includes(reason);
}

export async function ensureLunaCandidateQualityGovernanceSchema() {
  await run(`
    CREATE TABLE IF NOT EXISTS luna_candidate_quality_governance_shadow (
      id                            BIGSERIAL PRIMARY KEY,
      symbol                        TEXT NOT NULL,
      market                        TEXT NOT NULL,
      exchange                      TEXT NOT NULL,
      governance_action             TEXT NOT NULL,
      priority_score                DOUBLE PRECISION DEFAULT 0,
      cooldown_until                TIMESTAMPTZ,
      replacement_needed            BOOLEAN DEFAULT FALSE,
      skip_backtest_until_cooldown  BOOLEAN DEFAULT FALSE,
      recommended_next_command      TEXT,
      shadow_only                   BOOLEAN DEFAULT TRUE,
      live_mutation                 BOOLEAN DEFAULT FALSE,
      reasons                       JSONB DEFAULT '[]'::jsonb,
      evidence                      JSONB DEFAULT '{}'::jsonb,
      observed_at                   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_candidate_quality_governance_symbol ON luna_candidate_quality_governance_shadow(symbol, market, observed_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_candidate_quality_governance_action ON luna_candidate_quality_governance_shadow(governance_action, observed_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_candidate_quality_governance_cooldown ON luna_candidate_quality_governance_shadow(cooldown_until)`);
}

export function fixtureCandidateQualityGovernanceInputs() {
  const now = new Date().toISOString();
  return [
    {
      symbol: 'BTC/USDT',
      market: 'crypto',
      exchange: 'binance',
      recommendedAction: 'monitor_pass_candidate',
      severity: 'pass',
      candidateScore: 0.88,
      candidateSelectionPenalty: 0,
      reasons: [],
      recentUnhealthyCount24h: 0,
      observedAt: now,
    },
    {
      symbol: 'NEG/USDT',
      market: 'crypto',
      exchange: 'binance',
      recommendedAction: 'quarantine_candidate_shadow',
      severity: 'blocker',
      candidateScore: 0.79,
      candidateSelectionPenalty: 0.68,
      reasons: ['backtest_unhealthy_or_would_block', 'sharpe_negative', 'predictive_blocked'],
      recentUnhealthyCount24h: 3,
      observedAt: now,
    },
    {
      symbol: 'ALPHA/USDT',
      market: 'crypto',
      exchange: 'binance',
      recommendedAction: 'strategy_enhancement_shadow',
      severity: 'review',
      candidateScore: 0.82,
      candidateSelectionPenalty: 0.46,
      reasons: ['backtest_unhealthy_or_would_block', 'win_rate_low'],
      recentUnhealthyCount24h: 1,
      observedAt: now,
    },
    {
      symbol: 'MISS/USDT',
      market: 'crypto',
      exchange: 'binance',
      recommendedAction: 'refresh_evidence',
      severity: 'review',
      candidateScore: 0.71,
      candidateSelectionPenalty: 0.22,
      reasons: ['backtest_missing_or_stale', 'predictive_missing_or_stale', 'community_coverage_low'],
      recentUnhealthyCount24h: 0,
      observedAt: now,
    },
  ];
}

function governanceActionFor(row: any = {}) {
  const recommendedAction = String(row.recommendedAction || row.recommended_action || '').trim();
  const severity = String(row.severity || '').trim();
  const recentUnhealthyCount = n(row.recentUnhealthyCount24h ?? row.recent_unhealthy_count_24h, 0);
  if (recommendedAction === 'quarantine_candidate_shadow' || severity === 'blocker') {
    return 'candidate_cooldown_shadow';
  }
  if (hasReason(row, 'backtest_unhealthy_or_would_block') && recentUnhealthyCount >= 2) {
    return 'candidate_cooldown_shadow';
  }
  if (hasReason(row, 'backtest_missing_or_stale') || recommendedAction === 'refresh_evidence') {
    return 'refresh_backtest_priority';
  }
  if (recommendedAction === 'strategy_enhancement_shadow') {
    return 'strategy_repair_shadow';
  }
  return 'promotion_monitor_shadow';
}

function priorityFor(row: any = {}, governanceAction = '') {
  if (governanceAction === 'refresh_backtest_priority') return 0.92;
  if (governanceAction === 'strategy_repair_shadow') return round(0.62 + n(row.candidateSelectionPenalty ?? row.candidate_selection_penalty, 0) * 0.25, 4);
  if (governanceAction === 'candidate_cooldown_shadow') return 0.18;
  return 0.42;
}

function cooldownHoursFor(row: any = {}, governanceAction = '', options: any = {}) {
  if (governanceAction !== 'candidate_cooldown_shadow') return null;
  const recentUnhealthyCount = n(row.recentUnhealthyCount24h ?? row.recent_unhealthy_count_24h, 0);
  if (String(row.recommendedAction || row.recommended_action || '') === 'quarantine_candidate_shadow') {
    return n(options.quarantineCooldownHours, 168);
  }
  return recentUnhealthyCount >= 3
    ? n(options.repeatUnhealthyCooldownHours, 72)
    : n(options.unhealthyCooldownHours, 24);
}

function commandFor(row: any = {}, governanceAction = '') {
  const market = normalizeLunaPhase2Market(row.market);
  const symbol = normalizeLunaPhase2Symbol(row.symbol);
  const symbolArg = symbol ? ` --symbols=${symbol}` : '';
  if (governanceAction === 'refresh_backtest_priority') {
    return `npm --prefix bots/investment run -s runtime:luna-candidate-backtest-refresh -- --json --force --market=${market}${symbolArg}`;
  }
  if (governanceAction === 'strategy_repair_shadow') {
    return `npm --prefix bots/investment run -s runtime:luna-phase4-strategy-enhancement-shadow -- --json --dry-run --market=${market}${symbolArg}`;
  }
  if (governanceAction === 'candidate_cooldown_shadow') {
    return 'npm --prefix bots/investment run -s runtime:luna-discovery-refresh -- --json --force --markets=crypto,domestic,overseas --limit=30 --ttl-hours=6';
  }
  return `npm --prefix bots/investment run -s runtime:luna-paper-promotion-gate -- --json --dry-run --market=${market}${symbolArg}`;
}

export function buildLunaCandidateQualityGovernanceRows(inputs: any[] = [], options: any = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  return (inputs || []).map((input) => {
    const symbol = normalizeLunaPhase2Symbol(input.symbol);
    const market = normalizeLunaPhase2Market(input.market);
    const exchange = input.exchange || exchangeForLunaPhase2Market(market);
    const reasons = reasonList(input);
    const governanceAction = governanceActionFor(input);
    const cooldownHours = cooldownHoursFor(input, governanceAction, options);
    const cooldownUntil = cooldownHours ? addHours(now, cooldownHours) : null;
    const priorityScore = priorityFor(input, governanceAction);
    const replacementNeeded = governanceAction === 'candidate_cooldown_shadow';
    const skipBacktestUntilCooldown = Boolean(cooldownUntil);
    const recommendedNextCommand = commandFor({ ...input, symbol, market }, governanceAction);

    return {
      ok: true,
      symbol,
      market,
      exchange,
      governanceAction,
      priorityScore,
      cooldownUntil,
      replacementNeeded,
      skipBacktestUntilCooldown,
      recommendedNextCommand,
      shadowOnly: true,
      liveMutation: false,
      reasons,
      evidence: {
        phase: 'luna_candidate_quality_governance_shadow',
        source: 'luna_candidate_quality_governance',
        diagnostic: input,
        recentUnhealthyCount24h: n(input.recentUnhealthyCount24h ?? input.recent_unhealthy_count_24h, 0),
        cooldownHours,
        backtestBudgetPolicy: {
          skipRepeatedUnhealthyUntilCooldown: skipBacktestUntilCooldown,
          prioritizeMissingOrStale: true,
        },
        liveMutation: false,
      },
    };
  });
}

export async function loadLunaCandidateQualityGovernanceInputs({ limit = 50, market = null, symbols = [] } = {}) {
  const table = await query(`SELECT to_regclass('investment.luna_candidate_bottleneck_shadow') AS table_name`).then((rows) => rows?.[0]).catch(() => null);
  if (!table?.table_name) return [];
  const params: any[] = [];
  const requestedMarket = String(market || '').trim().toLowerCase();
  const normalizedMarket = requestedMarket && requestedMarket !== 'all' ? normalizeLunaPhase2Market(requestedMarket) : null;
  const requestedSymbols = normalizeLunaPhase2Symbols(symbols);
  const marketWhere = normalizedMarket ? `AND market = $${params.push(normalizedMarket)}` : '';
  const symbolWhere = requestedSymbols.length ? `AND symbol = ANY($${params.push(requestedSymbols)}::text[])` : '';
  params.push(Math.max(1, Number(limit || 50)));
  const rows = await query(`
    WITH recent_counts AS (
      SELECT symbol, market,
             COUNT(*)::int AS recent_count_24h,
             COUNT(*) FILTER (WHERE reasons @> '["backtest_unhealthy_or_would_block"]'::jsonb)::int AS recent_unhealthy_count_24h,
             COUNT(*) FILTER (WHERE recommended_action = 'quarantine_candidate_shadow')::int AS recent_quarantine_count_24h
       FROM luna_candidate_bottleneck_shadow
       WHERE observed_at >= NOW() - INTERVAL '24 hours'
         AND shadow_only IS TRUE
         ${marketWhere}
         ${symbolWhere}
       GROUP BY symbol, market
    ),
    latest AS (
      SELECT DISTINCT ON (symbol, market)
             symbol, market, exchange, severity, recommended_action, candidate_score,
             candidate_selection_penalty, reasons, evidence, observed_at
       FROM luna_candidate_bottleneck_shadow
       WHERE observed_at >= NOW() - INTERVAL '24 hours'
         AND shadow_only IS TRUE
         ${marketWhere}
         ${symbolWhere}
       ORDER BY symbol, market, observed_at DESC
    )
    SELECT latest.*, recent_counts.recent_count_24h,
           recent_counts.recent_unhealthy_count_24h,
           recent_counts.recent_quarantine_count_24h
      FROM latest
      JOIN recent_counts USING (symbol, market)
     ORDER BY latest.observed_at DESC, latest.candidate_selection_penalty DESC
     LIMIT $${params.length}
  `, params).catch(() => []);
  return (rows || []).map((row) => ({
    symbol: row.symbol,
    market: row.market,
    exchange: row.exchange,
    severity: row.severity,
    recommendedAction: row.recommended_action,
    candidateScore: row.candidate_score,
    candidateSelectionPenalty: row.candidate_selection_penalty,
    reasons: parseJsonMaybe(row.reasons, []),
    evidence: parseJsonMaybe(row.evidence, {}),
    observedAt: row.observed_at,
    recentCount24h: row.recent_count_24h,
    recentUnhealthyCount24h: row.recent_unhealthy_count_24h,
    recentQuarantineCount24h: row.recent_quarantine_count_24h,
  }));
}

export async function insertLunaCandidateQualityGovernanceShadow(row: any = {}) {
  await run(`
    INSERT INTO luna_candidate_quality_governance_shadow
      (symbol, market, exchange, governance_action, priority_score, cooldown_until,
       replacement_needed, skip_backtest_until_cooldown, recommended_next_command,
       shadow_only, live_mutation, reasons, evidence)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,false,$10::jsonb,$11::jsonb)
  `, [
    row.symbol,
    row.market,
    row.exchange,
    row.governanceAction,
    row.priorityScore,
    row.cooldownUntil,
    row.replacementNeeded === true,
    row.skipBacktestUntilCooldown === true,
    row.recommendedNextCommand,
    JSON.stringify(row.reasons || []),
    JSON.stringify(row.evidence || {}),
  ]);
}

export async function loadLunaCandidateQualityCooldownSymbols({ market = null, limit = 500 } = {}) {
  const table = await query(`SELECT to_regclass('investment.luna_candidate_quality_governance_shadow') AS table_name`).then((rows) => rows?.[0]).catch(() => null);
  if (!table?.table_name) return [];
  const params: any[] = [];
  const requestedMarket = String(market || '').trim().toLowerCase();
  const normalizedMarket = requestedMarket && requestedMarket !== 'all' ? normalizeLunaPhase2Market(requestedMarket) : null;
  const marketWhere = normalizedMarket ? `AND market = $${params.push(normalizedMarket)}` : '';
  params.push(Math.max(1, Number(limit || 500)));
  const rows = await query(`
    SELECT DISTINCT ON (symbol, market)
           symbol, market, governance_action, cooldown_until, observed_at
      FROM luna_candidate_quality_governance_shadow
     WHERE governance_action = 'candidate_cooldown_shadow'
       AND skip_backtest_until_cooldown IS TRUE
       AND cooldown_until > NOW()
       AND shadow_only IS TRUE
       ${marketWhere}
     ORDER BY symbol, market, observed_at DESC
     LIMIT $${params.length}
  `, params).catch(() => []);
  return (rows || []).map((row) => ({
    symbol: normalizeLunaPhase2Symbol(row.symbol),
    market: normalizeLunaPhase2Market(row.market),
    key: `${normalizeLunaPhase2Symbol(row.symbol)}|${normalizeLunaPhase2Market(row.market)}`,
    cooldownUntil: row.cooldown_until,
    governanceAction: row.governance_action,
  }));
}
