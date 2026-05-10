#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';

function parseArgs(argv = []) {
  return {
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
    limit: Number(argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1] || '3000'),
  };
}

function normalizeFamily(value = null) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return null;
  if (text.includes('trend')) return 'trend_following';
  if (text.includes('momentum')) return 'momentum_rotation';
  if (text.includes('break')) return 'breakout';
  if (text.includes('mean') || text.includes('reversion')) return 'mean_reversion';
  if (text.includes('defensive')) return 'defensive_rotation';
  if (text.includes('swing')) return 'equity_swing';
  return text;
}

function finiteNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function deriveQuality(readiness = null) {
  const score = finiteNumber(readiness, null);
  if (score == null) return null;
  if (score >= 0.72) return 'ready';
  if (score >= 0.56) return 'watch';
  return 'thin';
}

function normalizeRoute(route = null, family = null, quality = null, readiness = null) {
  const body = route && typeof route === 'object' ? { ...route } : {};
  if (family && !body.selectedFamily) body.selectedFamily = family;
  if (family && !body.setupType) body.setupType = family;
  if (quality && !body.quality) body.quality = quality;
  if (readiness != null && body.readinessScore == null) body.readinessScore = readiness;
  return Object.keys(body).length > 0 ? body : null;
}

function buildCandidateFromSignal(signal = null) {
  if (!signal) return null;
  const route = signal.strategy_route || null;
  const family = normalizeFamily(signal.strategy_family || route?.selectedFamily || route?.setupType || null);
  if (!family) return null;
  const readiness = finiteNumber(
    signal.strategy_readiness
      ?? route?.readinessScore
      ?? route?.readiness
      ?? route?.predictiveScore
      ?? signal.confidence,
    null,
  );
  const quality = signal.strategy_quality || route?.quality || deriveQuality(readiness);
  return {
    source: 'signal',
    strategyFamily: family,
    strategyQuality: quality,
    strategyReadiness: readiness,
    strategyRoute: normalizeRoute(route, family, quality, readiness),
  };
}

function buildCandidateFromProfile(profile = null) {
  if (!profile) return null;
  const route = profile.strategy_context?.strategyRoute || null;
  const family = normalizeFamily(route?.selectedFamily || route?.setupType || profile.setup_type || null);
  if (!family) return null;
  const readiness = finiteNumber(route?.readinessScore ?? route?.readiness, null);
  const quality = route?.quality || deriveQuality(readiness);
  return {
    source: 'profile',
    strategyFamily: family,
    strategyQuality: quality,
    strategyReadiness: readiness,
    strategyRoute: normalizeRoute(route, family, quality, readiness) || { selectedFamily: family, setupType: profile.setup_type || family },
  };
}

function buildCandidateFromRationale(rationale = null) {
  const config = rationale?.strategy_config || null;
  const family = normalizeFamily(config?.selected_strategy_family || config?.setup_type || config?.strategy_family || null);
  if (!family) return null;
  const readiness = finiteNumber(config?.strategy_readiness ?? config?.strategy_route?.readinessScore, null);
  const quality = config?.strategy_quality || config?.strategy_route?.quality || deriveQuality(readiness);
  return {
    source: 'rationale',
    strategyFamily: family,
    strategyQuality: quality,
    strategyReadiness: readiness,
    strategyRoute: normalizeRoute(config?.strategy_route, family, quality, readiness) || { selectedFamily: family, setupType: config?.setup_type || family },
  };
}

async function findProfile(signal) {
  const bySignal = await db.get(
    `SELECT *
     FROM position_strategy_profiles
     WHERE signal_id = $1
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`,
    [signal.id],
  ).catch(() => null);
  if (bySignal) return bySignal;

  return db.get(
    `SELECT *
     FROM position_strategy_profiles
     WHERE symbol = $1
       AND exchange = $2
       AND COALESCE(trade_mode, 'normal') = $3
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`,
    [signal.symbol, signal.exchange, signal.trade_mode || 'normal'],
  ).catch(() => null);
}

async function backfillSignalStrategyRoutes({ dryRun = false, limit = 3000 } = {}) {
  await db.initSchema();

  const rows = await db.query(
    `SELECT id, symbol, exchange, trade_mode, confidence,
            strategy_family, strategy_quality, strategy_readiness, strategy_route
     FROM investment.signals
     WHERE COALESCE(strategy_family, '') = ''
        OR COALESCE(strategy_quality, '') = ''
        OR strategy_readiness IS NULL
        OR strategy_route IS NULL
     ORDER BY created_at DESC
     LIMIT $1`,
    [Math.max(1, Number(limit || 3000))],
  );

  let updated = 0;
  let unresolved = 0;
  const bySource = { signal: 0, profile: 0, rationale: 0 };
  const samples = [];

  for (const row of rows) {
    const [profile, rationale] = await Promise.all([
      findProfile(row),
      db.get(
        `SELECT strategy_config
         FROM investment.trade_rationale
         WHERE signal_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [row.id],
      ).catch(() => null),
    ]);

    const candidate = buildCandidateFromSignal(row) || buildCandidateFromProfile(profile) || buildCandidateFromRationale(rationale);
    if (!candidate?.strategyFamily) {
      unresolved += 1;
      continue;
    }

    if (!dryRun) {
      await db.run(
        `UPDATE investment.signals
         SET strategy_family = COALESCE(strategy_family, $1),
             strategy_quality = COALESCE(strategy_quality, $2),
             strategy_readiness = COALESCE(strategy_readiness, $3),
             strategy_route = CASE
               WHEN $4::jsonb IS NULL THEN strategy_route
               WHEN strategy_route IS NULL THEN $4::jsonb
               ELSE strategy_route || $4::jsonb
             END
         WHERE id = $5`,
        [
          candidate.strategyFamily,
          candidate.strategyQuality ?? null,
          candidate.strategyReadiness ?? null,
          candidate.strategyRoute ? JSON.stringify(candidate.strategyRoute) : null,
          row.id,
        ],
      );
    }

    updated += 1;
    if (bySource[candidate.source] != null) bySource[candidate.source] += 1;
    if (samples.length < 12) {
      samples.push({
        signalId: row.id,
        symbol: row.symbol,
        exchange: row.exchange,
        tradeMode: row.trade_mode || 'normal',
        source: candidate.source,
        strategyFamily: candidate.strategyFamily,
        strategyQuality: candidate.strategyQuality,
        strategyReadiness: candidate.strategyReadiness,
      });
    }
  }

  return {
    scanned: rows.length,
    updated,
    unresolved,
    bySource,
    dryRun,
    samples,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await backfillSignalStrategyRoutes(args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`scanned=${result.scanned} updated=${result.updated} unresolved=${result.unresolved}`);
  console.log(`sources=${JSON.stringify(result.bySource)}`);
  if (result.samples.length) {
    console.log(`samples=${JSON.stringify(result.samples, null, 2)}`);
  }
}

main().catch((err) => {
  console.error('❌ signal strategy route backfill 실패:', err?.message || String(err));
  process.exit(1);
});
