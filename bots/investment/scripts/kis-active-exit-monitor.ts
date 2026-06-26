#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { runCliMain, isDirectExecution } from '../shared/cli-runtime.ts';
import { evaluateKisMarketHours } from '../shared/kis-market-hours-guard.ts';
import { getExitDecisions } from '../team/luna.ts';

const ACTIVE_EXIT_ORIGIN = 'kis_active_exit_monitor';
const SIGNAL_REVERSE_REASON = 'signal_reverse';

function boolEnv(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function argValue(argv, name, fallback = null) {
  const prefix = `--${name}=`;
  const found = argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

export function parseKisActiveExitArgs(argv = process.argv.slice(2), env = process.env) {
  const enabled = boolEnv(env.LUNA_KIS_ACTIVE_EXIT_ENABLED);
  return {
    json: argv.includes('--json'),
    dryRun: argv.includes('--dry-run') || !enabled,
    enabled,
    exchange: argValue(argv, 'exchange', 'all'),
    limit: Math.max(1, Number(argValue(argv, 'limit', 50)) || 50),
  };
}

function normalizeExchanges(exchange = 'all') {
  const normalized = String(exchange || 'all').trim().toLowerCase();
  if (normalized === 'all') return ['kis', 'kis_overseas'];
  if (normalized === 'domestic') return ['kis'];
  if (normalized === 'overseas') return ['kis_overseas'];
  if (normalized === 'kis' || normalized === 'kis_overseas') return [normalized];
  throw new Error(`invalid_kis_active_exit_exchange:${exchange}`);
}

function marketForExchange(exchange) {
  return exchange === 'kis_overseas' ? 'overseas' : 'domestic';
}

function positionValue(position = {}) {
  const amount = Number(position.amount || 0);
  const price = Number(position.current_price || position.avg_price || 0);
  return amount > 0 && price > 0 ? amount * price : null;
}

function normalizeExitResult(result) {
  if (Array.isArray(result)) return { decisions: result, exit_view: null };
  return {
    decisions: Array.isArray(result?.decisions) ? result.decisions : [],
    exit_view: result?.exit_view || null,
  };
}

export async function findPendingOrApprovedSellSignal(candidate, queryFn = db.query) {
  const rows = await queryFn(
    `SELECT id
       FROM signals
      WHERE symbol = $1
        AND action = 'SELL'
        AND exchange = $2
        AND COALESCE(trade_mode, 'normal') = $3
        AND status IN ('pending', 'approved')
      ORDER BY created_at DESC
      LIMIT 1`,
    [candidate.symbol, candidate.exchange, candidate.tradeMode || 'normal'],
  ).catch(() => []);
  return rows?.[0] || null;
}

export async function insertSignalReverseExitSignal(candidate, deps = {}) {
  const database = deps.db || db;
  const signalId = await database.insertSignal({
    symbol: candidate.symbol,
    action: 'SELL',
    amountUsdt: candidate.positionValue,
    confidence: candidate.confidence,
    reasoning: candidate.reasoning,
    exchange: candidate.exchange,
    tradeMode: candidate.tradeMode || 'normal',
    nemesisVerdict: 'approved',
    approvedAt: candidate.approvedAt || new Date().toISOString(),
    executionOrigin: ACTIVE_EXIT_ORIGIN,
    qualityFlag: 'trusted',
    excludeFromLearning: false,
    incidentLink: SIGNAL_REVERSE_REASON,
  });
  return { signalId };
}

export async function evaluateExchangeForActiveExit(exchange, options = {}, deps = {}) {
  const database = deps.db || db;
  const marketHours = deps.evaluateKisMarketHours || evaluateKisMarketHours;
  const decideExits = deps.getExitDecisions || getExitDecisions;
  const queryFn = deps.queryFn || database.query;
  const now = options.now ? new Date(options.now) : new Date();
  const market = marketForExchange(exchange);
  const marketStatus = marketHours({ market, now });
  const output = {
    exchange,
    market,
    marketStatus,
    scanned: 0,
    decisions: [],
    sellCandidates: [],
    inserted: [],
    skipped: [],
    errors: [],
  };

  if (!marketStatus?.isOpen) {
    output.skipped.push({ exchange, reason: marketStatus?.reasonCode || marketStatus?.reason || 'market_closed' });
    return output;
  }

  const positions = (await database.getOpenPositions(exchange, false, options.tradeMode || null).catch((error) => {
    output.errors.push({ exchange, stage: 'load_positions', error: error?.message || String(error) });
    return [];
  })).slice(0, options.limit || 50);
  output.scanned = positions.length;
  if (positions.length === 0) return output;

  const exitResult = normalizeExitResult(await decideExits(positions, exchange).catch((error) => {
    output.errors.push({ exchange, stage: 'get_exit_decisions', error: error?.message || String(error) });
    return { decisions: [] };
  }));
  output.decisions = exitResult.decisions.map((decision) => ({
    symbol: decision.symbol,
    action: decision.action,
    confidence: decision.confidence ?? null,
    reasoning: decision.reasoning || null,
  }));

  const bySymbol = new Map(positions.map((position) => [String(position.symbol), position]));
  for (const decision of exitResult.decisions) {
    if (String(decision?.action || '').toUpperCase() !== 'SELL') continue;
    const position = bySymbol.get(String(decision.symbol));
    if (!position) continue;
    const candidate = {
      symbol: position.symbol,
      exchange,
      tradeMode: position.trade_mode || 'normal',
      positionValue: positionValue(position),
      confidence: Math.max(0, Math.min(1, Number(decision.confidence ?? 0.6))),
      reasoning: `KIS active signal_reverse: ${String(decision.reasoning || 'SELL 판단').slice(0, 180)}`,
      approvedAt: now.toISOString(),
    };
    output.sellCandidates.push(candidate);

    const duplicate = await (deps.findPendingOrApprovedSellSignal || findPendingOrApprovedSellSignal)(candidate, queryFn);
    if (duplicate) {
      output.skipped.push({ symbol: candidate.symbol, exchange, reason: 'duplicate_sell_signal', signalId: duplicate.id });
      continue;
    }
    if (options.dryRun) {
      output.skipped.push({ symbol: candidate.symbol, exchange, reason: 'dry_run' });
      continue;
    }
    try {
      const inserted = await (deps.insertSignalReverseExitSignal || insertSignalReverseExitSignal)(candidate, { db: database });
      output.inserted.push({ symbol: candidate.symbol, exchange, signalId: inserted.signalId });
    } catch (error) {
      output.errors.push({ symbol: candidate.symbol, exchange, stage: 'insert_signal', error: error?.message || String(error) });
    }
  }

  return output;
}

export async function runKisActiveExitMonitor(options = {}, deps = {}) {
  const exchanges = normalizeExchanges(options.exchange || 'all');
  const dryRun = options.dryRun !== false;
  const effectiveOptions = { ...options, dryRun };
  const results = [];
  for (const exchange of exchanges) {
    results.push(await evaluateExchangeForActiveExit(exchange, effectiveOptions, deps));
  }
  return {
    ok: results.every((item) => item.errors.length === 0),
    dryRun,
    enabled: options.enabled === true,
    exchanges,
    scanned: results.reduce((sum, item) => sum + item.scanned, 0),
    decisions: results.flatMap((item) => item.decisions.map((decision) => ({ ...decision, exchange: item.exchange }))),
    sellCandidates: results.flatMap((item) => item.sellCandidates),
    inserted: results.flatMap((item) => item.inserted),
    skipped: results.flatMap((item) => item.skipped),
    errors: results.flatMap((item) => item.errors),
    results,
    liveMutation: false,
  };
}

async function main() {
  const options = parseKisActiveExitArgs();
  const result = await runKisActiveExitMonitor(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`[kis-active-exit-monitor] scanned=${result.scanned} sell=${result.sellCandidates.length} inserted=${result.inserted.length} dryRun=${result.dryRun}`);
  return result;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'kis-active-exit-monitor 실패:' });
}
