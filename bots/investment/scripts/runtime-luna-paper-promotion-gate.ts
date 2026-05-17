#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildLunaPaperPromotionGateReport,
  ensureLunaPaperPromotionGateSchema,
  insertLunaPaperPromotionGateShadow,
  LUNA_PAPER_PROMOTION_LOADER_LIMIT_SEMANTICS,
  loadLunaPaperPromotionRows,
} from '../shared/luna-paper-promotion-gate.ts';
import {
  normalizeLunaPhase2Market,
  normalizeLunaPhase2Symbol,
} from '../shared/luna-weight-vector.ts';

function argValue(name: string, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function normalizePromotionSymbol(symbol: any = '') {
  const raw = normalizeLunaPhase2Symbol(symbol);
  if (/^[A-Z0-9]+USDT$/.test(raw) && !raw.includes('/') && raw.length > 6) {
    return `${raw.slice(0, -4)}/USDT`;
  }
  return raw;
}

function symbolsFrom(value: any = '') {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(values.map((symbol) => normalizePromotionSymbol(symbol)).filter(Boolean))];
}

function promotionSymbolKey(row: any = {}) {
  const symbol = normalizePromotionSymbol(row.symbol);
  const market = normalizeLunaPhase2Market(row.market || 'crypto');
  return symbol ? `${symbol}|${market}` : null;
}

async function loadActivePromotionSymbolKeys({ market = null } = {}) {
  const params = [];
  const marketWhere = market ? `AND market = $${params.push(market)}` : '';
  const rows = await db.query(`
    SELECT DISTINCT market,
           CASE
             WHEN market = 'crypto' AND symbol ~ '^[A-Za-z0-9]+/USDT$' THEN UPPER(symbol)
             WHEN market = 'crypto' AND symbol ~ '^[A-Za-z0-9]+USDT$' THEN REGEXP_REPLACE(UPPER(symbol), 'USDT$', '/USDT')
             WHEN market = 'domestic' AND symbol ~ '^[0-9]{6}$' THEN symbol
             WHEN market = 'overseas' AND symbol !~ '/' AND symbol !~ '^[0-9]{6}$' AND symbol ~ '^[A-Za-z][A-Za-z0-9.\\-]{0,12}$' THEN UPPER(symbol)
             ELSE NULL
           END AS normalized_symbol
      FROM candidate_universe
     WHERE expires_at > NOW()
       ${marketWhere}
  `, params).catch(() => []);
  return new Set((rows || [])
    .map((row) => {
      const symbol = normalizePromotionSymbol(row.normalized_symbol);
      const m = normalizeLunaPhase2Market(row.market || 'crypto');
      return symbol ? `${symbol}|${m}` : null;
    })
    .filter(Boolean));
}

function fixtureRows() {
  const base = Date.now();
  const observedAt = (minutesAgo) => new Date(base - minutesAgo * 60_000).toISOString();
  const buyEvidence = {
    bottleneckAvoidance: { present: false, hardHold: false, preventedOrder: false },
    weightVector: { noLookaheadOk: true },
    promotionBacktestQuality: {
      fresh: true,
      healthy: true,
      sharpe: 1.5,
      gateStatus: 'pass',
      fallbackUsed: false,
      vectorbtEnabled: true,
    },
    promotionStrategyQuality: {
      enhancementStatus: 'shadow_ready',
      hyperoptStatus: 'not_required',
      maxDrawdownGuard: 'observe',
      indicatorScore: 0.75,
    },
  };
  const hardHoldEvidence = {
    ...buyEvidence,
    bottleneckAvoidance: {
      present: true,
      action: 'quarantine_candidate_shadow',
      hardHold: true,
      preventedOrder: false,
    },
  };
  return [
    { symbol: 'PASS/USDT', market: 'crypto', exchange: 'binance', paper_side: 'BUY', paper_notional_usdt: 20, confidence: 0.75, status: 'planned', shadow_only: true, evidence: buyEvidence, observed_at: observedAt(1) },
    { symbol: 'PASS/USDT', market: 'crypto', exchange: 'binance', paper_side: 'BUY', paper_notional_usdt: 18, confidence: 0.72, status: 'planned', shadow_only: true, evidence: buyEvidence, observed_at: observedAt(31) },
    { symbol: 'PASS/USDT', market: 'crypto', exchange: 'binance', paper_side: 'BUY', paper_notional_usdt: 16, confidence: 0.70, status: 'planned', shadow_only: true, evidence: buyEvidence, observed_at: observedAt(61) },
    { symbol: 'RISK/USDT', market: 'crypto', exchange: 'binance', paper_side: 'HOLD', paper_notional_usdt: 0, confidence: 0.52, status: 'no_action', shadow_only: true, evidence: hardHoldEvidence, observed_at: observedAt(2) },
    { symbol: 'RISK/USDT', market: 'crypto', exchange: 'binance', paper_side: 'BUY', paper_notional_usdt: 12, confidence: 0.66, status: 'planned', shadow_only: true, evidence: buyEvidence, observed_at: observedAt(32) },
    { symbol: 'RISK/USDT', market: 'crypto', exchange: 'binance', paper_side: 'BUY', paper_notional_usdt: 11, confidence: 0.64, status: 'planned', shadow_only: true, evidence: buyEvidence, observed_at: observedAt(62) },
  ];
}

export async function runLunaPaperPromotionGateShadow(options: any = {}, deps: any = {}) {
  const apply = options.apply === true;
  const dryRun = options.dryRun === true || !apply;
  const confirm = String(options.confirm || '');
  const fixture = options.fixture === true;
  const json = options.json === true;
  const hours = Math.max(1, Number(options.hours || 24));
  const limit = Math.max(1, Number(options.limit || 500));
  const requestedMarket = String(options.market || '').trim().toLowerCase();
  const market = requestedMarket && requestedMarket !== 'all'
    ? normalizeLunaPhase2Market(requestedMarket)
    : null;
  const requestedSymbols = symbolsFrom(options.symbols || process.env.LUNA_PAPER_PROMOTION_SYMBOLS || '');
  const activeOnly = fixture ? false : options.activeOnly !== false;

  if (apply && confirm !== 'luna-paper-promotion-gate-shadow') {
    throw new Error('runtime:luna-paper-promotion-gate apply requires --confirm=luna-paper-promotion-gate-shadow');
  }
  if (apply && options.dryRun === true) {
    throw new Error('runtime:luna-paper-promotion-gate cannot combine --apply with --dry-run');
  }

  const rawRows = fixture
    ? fixtureRows()
    : deps.loadRows
      ? await deps.loadRows({ hours, limit, market, symbols: requestedSymbols })
      : await loadLunaPaperPromotionRows({ hours, limit, market, symbols: requestedSymbols });
  const symbolFilteredRows = requestedSymbols.length
    ? rawRows.filter((row) => requestedSymbols.includes(normalizePromotionSymbol(row.symbol)))
    : rawRows;
  const activeSymbolKeys = activeOnly
    ? deps.loadActiveSymbolKeys
      ? await deps.loadActiveSymbolKeys({ market, symbols: requestedSymbols })
      : await loadActivePromotionSymbolKeys({ market })
    : null;
  const rows = activeOnly && activeSymbolKeys
    ? symbolFilteredRows.filter((row) => {
      const key = promotionSymbolKey(row);
      return key && activeSymbolKeys.has(key);
    })
    : symbolFilteredRows;
  const report = buildLunaPaperPromotionGateReport(rows, {
    minCycles: options.minCycles,
    minConsecutivePasses: options.minConsecutivePasses,
    minAvgConfidence: options.minAvgConfidence,
    maxOrderUsdt: options.maxOrderUsdt,
    maxPromotionSharpe: options.maxPromotionSharpe,
  });

  if (apply && !dryRun && report.items.length > 0) {
    if (deps.ensureSchema) await deps.ensureSchema();
    else {
      await db.initSchema();
      await ensureLunaPaperPromotionGateSchema();
    }
    for (const row of report.items) {
      if (deps.insertGate) await deps.insertGate(row);
      else await insertLunaPaperPromotionGateShadow(row);
    }
  }

  const payload = {
    ...report,
    status: apply ? 'luna_paper_promotion_gate_shadow_written' : report.status,
    dryRun,
    apply,
    fixture,
    writeMode: apply ? 'promotion-gate-shadow-apply' : 'plan-only',
    market: market || 'all',
    requestedSymbols,
    activePromotionFilter: {
      enabled: activeOnly,
      activeSymbolCount: activeSymbolKeys ? activeSymbolKeys.size : null,
      rawRowCount: rawRows.length,
      symbolFilteredRowCount: symbolFilteredRows.length,
      excludedInactiveRowCount: symbolFilteredRows.length - rows.length,
    },
    hours,
    limit,
    limitSemantics: LUNA_PAPER_PROMOTION_LOADER_LIMIT_SEMANTICS,
    liveMutation: false,
  };

  if (!json) {
    console.log(`[luna-paper-promotion-gate] ${payload.status} total=${payload.summary.totalSymbols} candidates=${payload.summary.promotionCandidates}`);
  }
  return payload;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runLunaPaperPromotionGateShadow({
      json: hasFlag('json'),
      dryRun: hasFlag('dry-run'),
      apply: hasFlag('apply'),
      fixture: hasFlag('fixture'),
      hours: Number(argValue('hours', 24)),
      limit: Number(argValue('limit', 500)),
      market: argValue('market', null),
      symbols: argValue('symbols', process.env.LUNA_PAPER_PROMOTION_SYMBOLS || ''),
      activeOnly: !hasFlag('include-inactive'),
      confirm: argValue('confirm', ''),
      minCycles: Number(argValue('min-cycles', process.env.LUNA_PAPER_PROMOTION_MIN_CYCLES || 3)),
      minConsecutivePasses: Number(argValue('min-consecutive-passes', process.env.LUNA_PAPER_PROMOTION_MIN_CONSECUTIVE_PASSES || 3)),
      minAvgConfidence: Number(argValue('min-avg-confidence', process.env.LUNA_PAPER_PROMOTION_MIN_AVG_CONFIDENCE || 0.62)),
      maxOrderUsdt: Number(argValue('max-order-usdt', process.env.LUNA_MAX_TRADE_USDT || 50)),
      maxPromotionSharpe: Number(argValue('max-promotion-sharpe', process.env.LUNA_PAPER_PROMOTION_MAX_SHARPE || 8)),
    }),
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'runtime-luna-paper-promotion-gate error:',
  });
}
