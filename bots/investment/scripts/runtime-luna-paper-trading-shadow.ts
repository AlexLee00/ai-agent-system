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

export async function runLunaPaperTradingShadow(options: any = {}, deps: any = {}) {
  const apply = options.apply === true;
  const dryRun = options.dryRun === true || !apply;
  const confirm = String(options.confirm || '');
  const fixture = options.fixture === true;
  const json = options.json === true;
  const limit = Math.max(1, Number(options.limit || process.env.LUNA_PHASE2_PAPER_LIMIT || 50));
  const hours = Math.max(1, Number(options.hours || 24));
  const market = options.market ? normalizeLunaPhase2Market(options.market) : null;
  const equityUsdt = Math.max(1, Number(options.equityUsdt || process.env.LUNA_PHASE2_PAPER_EQUITY_USDT || 1000));
  const maxOrderUsdt = Math.max(0, Number(process.env.LUNA_MAX_TRADE_USDT || 50));

  if (apply && confirm !== 'luna-paper-trading-shadow') {
    throw new Error('runtime:luna-paper-trading-shadow apply requires --confirm=luna-paper-trading-shadow');
  }

  let rawWeights = fixture
    ? (await runLunaWeightVectorShadow({ json: true, fixture: true, dryRun: true, apply: false })).rows
    : deps.loadWeights
      ? await deps.loadWeights({ limit, hours, market })
      : await loadLatestLunaWeightVectors({ limit, hours, market });
  if (!fixture && !apply && rawWeights.length === 0) {
    const planned = await runLunaWeightVectorShadow({
      json: true,
      dryRun: true,
      apply: false,
      limit,
      market,
    });
    rawWeights = planned.rows || [];
  }

  const weights = rawWeights.map(normalizeWeightRow);
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
      equityUsdt: Number(argValue('equity-usdt', process.env.LUNA_PHASE2_PAPER_EQUITY_USDT || 1000)),
      confirm: argValue('confirm', ''),
    }),
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'runtime-luna-paper-trading-shadow error:',
  });
}
