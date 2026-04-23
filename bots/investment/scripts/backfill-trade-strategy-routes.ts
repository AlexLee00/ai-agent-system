#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import * as journalDb from '../shared/trade-journal-db.ts';

function parseArgs(argv = []) {
  return {
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
    limit: Number(argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1] || '2000'),
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

function buildCandidateFromSignal(signal = null) {
  if (!signal) return null;
  const route = signal.strategy_route || null;
  const family = normalizeFamily(signal.strategy_family || route?.selectedFamily || route?.setupType || null);
  if (!family) return null;
  return {
    source: 'signal',
    strategyFamily: family,
    strategyQuality: signal.strategy_quality || route?.quality || null,
    strategyReadiness: signal.strategy_readiness ?? route?.readinessScore ?? null,
    strategyRoute: route || null,
  };
}

function buildCandidateFromProfile(profile = null) {
  if (!profile) return null;
  const route = profile.strategy_context?.strategyRoute || null;
  const family = normalizeFamily(route?.selectedFamily || route?.setupType || profile.setup_type || null);
  if (!family) return null;
  return {
    source: 'profile',
    strategyFamily: family,
    strategyQuality: route?.quality || null,
    strategyReadiness: route?.readinessScore ?? null,
    strategyRoute: route || (family ? { selectedFamily: family, setupType: profile.setup_type || family } : null),
  };
}

function buildCandidateFromRationale(rationale = null) {
  const config = rationale?.strategy_config || null;
  const family = normalizeFamily(config?.selected_strategy_family || config?.setup_type || config?.strategy_family || null);
  if (!family) return null;
  return {
    source: 'rationale',
    strategyFamily: family,
    strategyQuality: config?.strategy_quality || null,
    strategyReadiness: config?.strategy_readiness ?? null,
    strategyRoute: config?.strategy_route || { selectedFamily: family, setupType: config?.setup_type || family },
  };
}

async function findProfile(row) {
  if (row.signal_id) {
    const bySignal = await db.get(
      `SELECT *
       FROM position_strategy_profiles
       WHERE signal_id = $1
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 1`,
      [row.signal_id],
    ).catch(() => null);
    if (bySignal) return bySignal;
  }
  return db.get(
    `SELECT *
     FROM position_strategy_profiles
     WHERE symbol = $1
       AND exchange = $2
       AND COALESCE(trade_mode, 'normal') = $3
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`,
    [row.symbol, row.exchange, row.trade_mode || 'normal'],
  ).catch(() => null);
}

async function backfillTradeStrategyRoutes({ dryRun = false, limit = 2000 } = {}) {
  await db.initSchema();
  await journalDb.initJournalSchema();

  const rows = await db.query(
    `SELECT trade_id, signal_id, symbol, exchange, trade_mode
     FROM investment.trade_journal
     WHERE COALESCE(strategy_family, '') = ''
     ORDER BY created_at DESC
     LIMIT $1`,
    [Math.max(1, Number(limit || 2000))],
  );

  let updated = 0;
  let unresolved = 0;
  const bySource = { signal: 0, profile: 0, rationale: 0 };
  const samples = [];

  for (const row of rows) {
    const [signal, profile, rationale] = await Promise.all([
      row.signal_id ? db.getSignalById(row.signal_id).catch(() => null) : null,
      findProfile(row),
      db.get(
        `SELECT strategy_config
         FROM investment.trade_rationale
         WHERE trade_id = $1 OR signal_id = $2
         ORDER BY created_at DESC
         LIMIT 1`,
        [row.trade_id, row.signal_id ?? null],
      ).catch(() => null),
    ]);

    const candidate =
      buildCandidateFromSignal(signal)
      || buildCandidateFromProfile(profile)
      || buildCandidateFromRationale(rationale);

    if (!candidate?.strategyFamily) {
      unresolved += 1;
      continue;
    }

    if (!dryRun) {
      await db.run(
        `UPDATE investment.trade_journal
         SET strategy_family = COALESCE(strategy_family, $1),
             strategy_quality = COALESCE(strategy_quality, $2),
             strategy_readiness = COALESCE(strategy_readiness, $3),
             strategy_route = COALESCE(strategy_route, $4::jsonb)
         WHERE trade_id = $5`,
        [
          candidate.strategyFamily,
          candidate.strategyQuality ?? null,
          candidate.strategyReadiness ?? null,
          candidate.strategyRoute ? JSON.stringify(candidate.strategyRoute) : null,
          row.trade_id,
        ],
      );
    }

    updated += 1;
    if (bySource[candidate.source] != null) bySource[candidate.source] += 1;
    if (samples.length < 12) {
      samples.push({
        tradeId: row.trade_id,
        signalId: row.signal_id,
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
  const result = await backfillTradeStrategyRoutes(args);
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
  console.error('❌ trade_journal strategy route backfill 실패:', err?.message || String(err));
  process.exit(1);
});
