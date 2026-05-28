#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildLunaPaperTradingPlan,
  ensureLunaPhase2Schema,
  insertLunaPaperTradingShadow,
  loadCurrentPositionForWeightVector,
  loadLatestLunaWeightVectors,
  normalizeLunaPhase2Market,
  normalizeLunaPhase2Symbol,
} from '../shared/luna-weight-vector.ts';
import { runLunaWeightVectorShadow } from './runtime-luna-weight-vector-shadow.ts';

function argValue(name: string, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function symbolsFrom(value: any = '') {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(values.map((symbol) => normalizeLunaPhase2Symbol(symbol)).filter(Boolean))];
}

function normalizeWeightRow(row = {}) {
  return {
    symbol: row.symbol,
    market: normalizeLunaPhase2Market(row.market),
    exchange: row.exchange,
    targetWeight: Number(row.target_weight ?? row.targetWeight ?? 0),
    confidence: Number(row.confidence ?? 0),
    signal: row.signal,
    evidence: row.evidence || {},
    observedAt: row.observed_at || row.observedAt,
  };
}

function countBy(rows: any[] = [], selector: any = () => 'unknown') {
  return rows.reduce((acc, row) => {
    const value = selector(row) || 'none';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

export async function runLunaPaperTradingShadow(options: any = {}, deps: any = {}) {
  const apply = options.apply === true;
  const dryRun = options.dryRun === true || !apply;
  const confirm = String(options.confirm || '');
  const fixture = options.fixture === true;
  const json = options.json === true;
  const limit = Math.max(1, Number(options.limit || process.env.LUNA_PHASE2_PAPER_LIMIT || 50));
  const hours = Math.max(1, Number(options.hours || 24));
  const requestedMarket = String(options.market || '').trim().toLowerCase();
  const market = requestedMarket && requestedMarket !== 'all'
    ? normalizeLunaPhase2Market(requestedMarket)
    : null;
  const requestedSymbols = symbolsFrom(options.symbols || process.env.LUNA_PHASE2_PAPER_SYMBOLS || '');
  const equityUsdt = Math.max(1, Number(options.equityUsdt || process.env.LUNA_PHASE2_PAPER_EQUITY_USDT || 1000));
  const maxOrderUsdt = Math.max(0, Number(process.env.LUNA_MAX_TRADE_USDT || 0));

  if (apply && confirm !== 'luna-paper-trading-shadow') {
    throw new Error('runtime:luna-paper-trading-shadow apply requires --confirm=luna-paper-trading-shadow');
  }

  let rawWeights = fixture
    ? (await runLunaWeightVectorShadow({ json: true, fixture: true, dryRun: true, apply: false, symbols: requestedSymbols.join(',') })).rows
    : deps.loadWeights
      ? await deps.loadWeights({ limit, hours, market, symbols: requestedSymbols })
      : await loadLatestLunaWeightVectors({ limit, hours, market, symbols: requestedSymbols });
  if (!fixture && !apply && rawWeights.length === 0) {
    const planned = await runLunaWeightVectorShadow({
      json: true,
      dryRun: true,
      apply: false,
      limit,
      market,
      symbols: requestedSymbols.join(','),
    });
    rawWeights = planned.rows || [];
  }

  const filteredRawWeights = requestedSymbols.length
    ? rawWeights.filter((row) => requestedSymbols.includes(normalizeLunaPhase2Symbol(row.symbol)))
    : rawWeights;
  const weights = filteredRawWeights.map(normalizeWeightRow);
  const rows = [];
  for (const weight of weights) {
    const position = deps.loadPosition
      ? await deps.loadPosition(weight)
      : fixture
        ? (weight.symbol === 'BTC/USDT' ? { symbol: 'BTC/USDT', amount: 0.01, avg_price: 65000, exchange: 'binance' } : null)
        : await loadCurrentPositionForWeightVector(weight);
    rows.push(buildLunaPaperTradingPlan(weight, {
      position,
      equityUsdt,
      maxOrderUsdt,
      minNotionalUsdt: 5,
      fallbackPrice: 1,
    }));
  }

  const summary = {
    total: rows.length,
    buy: rows.filter((row) => row.paperSide === 'BUY').length,
    sell: rows.filter((row) => row.paperSide === 'SELL').length,
    hold: rows.filter((row) => row.paperSide === 'HOLD').length,
    plannedNotionalUsdt: Number(rows.reduce((sum, row) => sum + Number(row.paperNotionalUsdt || 0), 0).toFixed(4)),
    bottleneckPenalized: rows.filter((row) => Number(row.evidence?.bottleneckAvoidance?.penalty || 0) > 0).length,
    bottleneckHardHold: rows.filter((row) => row.evidence?.bottleneckAvoidance?.hardHold === true).length,
    bottleneckPreventedOrder: rows.filter((row) => row.evidence?.bottleneckAvoidance?.preventedOrder === true).length,
    bottleneckAvoidedNotionalUsdt: Number(rows.reduce((sum, row) => sum + Number(row.evidence?.bottleneckAvoidance?.avoidedNotionalUsdt || 0), 0).toFixed(4)),
    byBottleneckAction: countBy(
      rows.filter((row) => row.evidence?.bottleneckAvoidance?.present === true),
      (row) => row.evidence?.bottleneckAvoidance?.action,
    ),
    liveMutation: false,
  };

  if (apply && rows.length > 0) {
    if (deps.ensureSchema) await deps.ensureSchema();
    else {
      await db.initSchema();
      await ensureLunaPhase2Schema();
    }
    for (const row of rows) {
      if (deps.insertPaper) await deps.insertPaper(row);
      else await insertLunaPaperTradingShadow(row);
    }
  }

  const payload = {
    ok: true,
    status: apply ? 'luna_paper_trading_shadow_written' : 'luna_paper_trading_shadow_planned',
    phase: 'luna_phase2_finrlx',
    dryRun,
    apply,
    fixture,
    writeMode: apply ? 'paper-shadow-apply' : 'plan-only',
    shadowMode: true,
    paperOnly: true,
    market: market || 'all',
    requestedSymbols,
    equityUsdt,
    maxOrderUsdt,
    summary,
    rows,
  };

  if (!json) {
    console.log(`[luna-phase2-paper] ${payload.status} total=${summary.total} buy=${summary.buy} sell=${summary.sell} hold=${summary.hold}`);
  }
  return payload;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runLunaPaperTradingShadow({
      json: hasFlag('json'),
      dryRun: hasFlag('dry-run'),
      apply: hasFlag('apply'),
      fixture: hasFlag('fixture'),
      limit: Number(argValue('limit', process.env.LUNA_PHASE2_PAPER_LIMIT || 50)),
      hours: Number(argValue('hours', 24)),
      market: argValue('market', null),
      symbols: argValue('symbols', process.env.LUNA_PHASE2_PAPER_SYMBOLS || ''),
      equityUsdt: Number(argValue('equity-usdt', process.env.LUNA_PHASE2_PAPER_EQUITY_USDT || 1000)),
      confirm: argValue('confirm', ''),
    }),
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'runtime-luna-paper-trading-shadow error:',
  });
}
