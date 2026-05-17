#!/usr/bin/env node
// @ts-nocheck

import { query as defaultQuery } from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { ensureLunaDiscoveryEntryTables } from '../shared/luna-discovery-entry-store.ts';
import { ensureLunaPaperPromotionGateSchema } from '../shared/luna-paper-promotion-gate.ts';
import { buildPromotionEntryTriggerCoverageReport } from '../shared/luna-promotion-entry-trigger-coverage.ts';

function argValue(name, fallback = null, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name, argv = process.argv.slice(2)) {
  return argv.includes(`--${name}`);
}

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: hasFlag('json', argv),
    strict: hasFlag('strict', argv),
    dryRun: hasFlag('dry-run', argv) || !hasFlag('apply', argv),
    apply: hasFlag('apply', argv),
    market: String(argValue('market', 'crypto', argv) || 'crypto').trim().toLowerCase(),
    exchange: String(argValue('exchange', 'binance', argv) || 'binance').trim().toLowerCase(),
    hours: Math.max(1, Number(argValue('hours', 168, argv)) || 168),
    limit: Math.max(1, Number(argValue('limit', 100, argv)) || 100),
  };
}

function symbolFilter(symbols = []) {
  const normalized = (symbols || []).map((item) => String(item || '').trim().toUpperCase()).filter(Boolean);
  if (!normalized.length) return { sql: '', params: [] };
  return {
    sql: ` AND symbol = ANY($SYMBOL_PARAM)`,
    params: [normalized],
  };
}

async function loadPromotionRows({ queryFn, market, exchange, hours, limit, symbols = [] }) {
  const filter = symbolFilter(symbols);
  let paramIndex = 5;
  const filterSql = filter.sql.replace('$SYMBOL_PARAM', `$${paramIndex}`);
  const params = [hours, market, exchange, limit, ...filter.params];
  return queryFn(
    `WITH latest AS (
       SELECT DISTINCT ON (symbol, market, exchange)
              symbol, market, exchange, decision, promotion_candidate,
              cycle_count, pass_count, consecutive_passes, avg_confidence,
              evidence, observed_at
         FROM luna_paper_promotion_gate_shadow
        WHERE observed_at >= now() - ($1::int * interval '1 hour')
          AND ($2 = 'all' OR market = $2)
          AND ($3 = 'all' OR exchange = $3)
          ${filterSql}
        ORDER BY symbol, market, exchange, observed_at DESC
     )
     SELECT *
       FROM latest
      WHERE promotion_candidate = TRUE
      ORDER BY avg_confidence DESC NULLS LAST, symbol ASC
      LIMIT $4`,
    params,
  ).catch(() => []);
}

async function loadTriggerRows({ queryFn, exchange, symbols = [], activeOnly = false }) {
  if (!symbols.length) return [];
  const states = activeOnly ? ['armed', 'waiting'] : ['armed', 'waiting', 'expired', 'fired', 'blocked'];
  return queryFn(
    `SELECT id, symbol, exchange, setup_type, trigger_type, trigger_state,
            confidence, predictive_score, expires_at, fired_at, created_at, updated_at
       FROM entry_triggers
      WHERE symbol = ANY($1)
        AND ($2 = 'all' OR exchange = $2)
        AND trigger_state = ANY($3)
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 500`,
    [symbols, exchange, states],
  ).catch(() => []);
}

export async function runLunaPromotionEntryTriggerCoverage(options = parseArgs(), deps = {}) {
  if (options.apply) {
    return {
      ok: false,
      status: 'luna_promotion_entry_trigger_coverage_apply_blocked',
      phase: 'luna_promotion_to_entry_trigger_coverage',
      shadowMode: true,
      liveMutation: false,
      protectedPidMutation: false,
      blockers: [{
        type: 'safety',
        name: 'apply_not_supported',
        detail: 'This coverage runtime is read-only. Entry-trigger materialization requires a separate explicit master-approved path.',
      }],
    };
  }

  const queryFn = deps.queryFn || defaultQuery;
  await ensureLunaPaperPromotionGateSchema().catch(() => {});
  await ensureLunaDiscoveryEntryTables().catch(() => {});

  const symbols = String(options.symbols || argValue('symbols', '') || '')
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);

  const promotionRows = deps.promotionRows || await loadPromotionRows({
    queryFn,
    market: options.market,
    exchange: options.exchange,
    hours: options.hours,
    limit: options.limit,
    symbols,
  });
  const promotionSymbols = [...new Set(promotionRows.map((row) => String(row.symbol || '').trim().toUpperCase()).filter(Boolean))];
  const activeTriggerRows = deps.activeTriggerRows || await loadTriggerRows({
    queryFn,
    exchange: options.exchange,
    symbols: promotionSymbols,
    activeOnly: true,
  });
  const latestTriggerRows = deps.latestTriggerRows || await loadTriggerRows({
    queryFn,
    exchange: options.exchange,
    symbols: promotionSymbols,
    activeOnly: false,
  });

  return buildPromotionEntryTriggerCoverageReport({
    promotionRows,
    activeTriggerRows,
    latestTriggerRows,
    now: deps.now || new Date(),
    hours: options.hours,
    market: options.market,
    exchange: options.exchange,
  });
}

async function main() {
  const options = parseArgs();
  const report = await runLunaPromotionEntryTriggerCoverage(options);
  if (options.strict && !report.ok) process.exitCode = 1;
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`${report.status} candidates=${report.summary?.promotionCandidates || 0} missingActiveTrigger=${report.summary?.missingActiveTrigger || 0}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'runtime-luna-promotion-entry-trigger-coverage error:',
  });
}

export default { runLunaPromotionEntryTriggerCoverage };
