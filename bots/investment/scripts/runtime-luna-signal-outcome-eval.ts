#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import {
  fetchPhaseABars,
  normalizePhaseAMarket,
  normalizePhaseASymbol,
} from '../shared/luna-phase-a-market-data.ts';
import {
  LUNA_SIGNAL_OUTCOME_CONFIRM,
  LUNA_SIGNAL_OUTCOME_DEFAULT_MAX_BARS,
  buildSignalOutcomeSummary,
  evaluateSignalOutcome,
  normalizeSignalForOutcome,
  upsertSignalOutcome,
} from '../shared/luna-signal-outcome.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export { LUNA_SIGNAL_OUTCOME_CONFIRM };

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function argValue(name: string, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function listValue(value: any, fallback: string[] = []) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

function lookbackDaysForSignal(signal: any, maxBars = LUNA_SIGNAL_OUTCOME_DEFAULT_MAX_BARS, now = new Date()) {
  const ts = Date.parse(String(signal.candle_ts || signal.candleTs || now.toISOString()));
  const bars = Number.isFinite(Number(maxBars)) ? Number(maxBars) : LUNA_SIGNAL_OUTCOME_DEFAULT_MAX_BARS;
  if (!Number.isFinite(ts)) return Math.max(60, bars + 10);
  return Math.max(bars + 10, Math.ceil((now.getTime() - ts) / 86_400_000) + bars + 5);
}

function parsePositiveInt(value: any, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : fallback;
}

export async function loadSignalOutcomeCandidates(options: any = {}, deps: any = {}) {
  const queryFn = deps.queryFn || db.query;
  const limit = Math.max(1, Number(options.limit || 100));
  const markets = listValue(options.markets || options.signalOutcomeMarkets, []);
  const rows = await queryFn(
    `SELECT s.id,
            s.family,
            s.signal_type,
            s.market,
            s.symbol,
            s.candle_ts,
            s.price,
            s.stop,
            s.target,
            s.rr,
            s.regime,
            s.matched,
            s.details,
            o.outcome AS previous_outcome
       FROM luna_strategy_signals s
       LEFT JOIN luna_strategy_signal_outcomes o ON o.signal_id = s.id
      WHERE s.signal_type = 'entry'
        AND s.price IS NOT NULL
        AND s.stop IS NOT NULL
        AND s.target IS NOT NULL
        AND ($1::text[] IS NULL OR s.market = ANY($1::text[]))
        AND (o.signal_id IS NULL OR o.outcome = 'open')
      ORDER BY s.candle_ts ASC, s.id ASC
      LIMIT $2`,
    [markets.length ? markets.map(normalizePhaseAMarket) : null, limit],
  );
  return rows || [];
}

export async function runLunaSignalOutcomeEval(options: any = {}, deps: any = {}) {
  const apply = options.apply === true;
  const dryRun = options.dryRun === true || !apply;
  const confirm = String(options.confirm || '');
  if (apply && confirm !== LUNA_SIGNAL_OUTCOME_CONFIRM) {
    throw new Error(`runtime-luna-signal-outcome-eval requires --confirm=${LUNA_SIGNAL_OUTCOME_CONFIRM}`);
  }

  const maxBars = parsePositiveInt(
    options.maxBars || options.signalOutcomeMaxBars || process.env.LUNA_SIGNAL_OUTCOME_MAX_BARS,
    LUNA_SIGNAL_OUTCOME_DEFAULT_MAX_BARS,
  );
  const now = options.now ? new Date(options.now) : new Date();
  const fetchBars = deps.fetchPhaseABars || fetchPhaseABars;
  const candidates = Array.isArray(options.signals)
    ? options.signals
    : await (deps.loadSignalOutcomeCandidates || loadSignalOutcomeCandidates)({
        ...options,
        maxBars,
      }, deps);
  const evaluatedRows = [];
  const errors = [];
  const writtenIds = [];

  for (const rawSignal of candidates || []) {
    try {
      const signal = normalizeSignalForOutcome(rawSignal);
      const lookbackDays = lookbackDaysForSignal(rawSignal, maxBars, now);
      const marketData = Array.isArray(options.barsBySignalId?.[signal.id])
        ? { bars: options.barsBySignalId[signal.id], source: 'provided_bars', error: null }
        : await fetchBars({
            symbol: normalizePhaseASymbol(signal.symbol, signal.market),
            market: normalizePhaseAMarket(signal.market),
            timeframe: '1d',
            lookbackDays,
            getOhlcv: options.getOhlcv,
          });
      if (marketData.error) throw new Error(marketData.error);
      const outcome = evaluateSignalOutcome(signal, marketData.bars || [], {
        maxBars,
        now,
        requireSignalId: true,
      });
      const enriched = {
        ...outcome,
        source: marketData.source,
      };
      evaluatedRows.push(enriched);
      if (apply && !dryRun) {
        const result = await (deps.upsertSignalOutcome || upsertSignalOutcome)(enriched, deps.runFn || db.run);
        writtenIds.push(result?.rows?.[0]?.id || null);
      }
    } catch (error) {
      errors.push({
        signalId: rawSignal?.id ?? rawSignal?.signal_id ?? rawSignal?.signalId ?? null,
        symbol: rawSignal?.symbol || null,
        error: error?.message || String(error),
      });
    }
  }

  const counts = evaluatedRows.reduce((acc, row) => {
    acc[row.outcome] = Number(acc[row.outcome] || 0) + 1;
    return acc;
  }, {});
  const summary = buildSignalOutcomeSummary(evaluatedRows);
  return {
    ok: errors.length === 0,
    dryRun,
    apply,
    maxBars,
    candidates: candidates.length,
    evaluated: evaluatedRows.length,
    written: writtenIds.length,
    writtenIds,
    counts,
    summary,
    rows: evaluatedRows,
    errors,
    shadowOnly: true,
    liveMutation: false,
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runLunaSignalOutcomeEval({
      dryRun: hasFlag('dry-run') || !hasFlag('apply'),
      apply: hasFlag('apply'),
      confirm: argValue('confirm', ''),
      limit: Number(argValue('limit', 100)),
      maxBars: Number(argValue('max-bars', LUNA_SIGNAL_OUTCOME_DEFAULT_MAX_BARS)),
      markets: argValue('markets', ''),
    }),
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: '❌ runtime-luna-signal-outcome-eval 실패:',
  });
}

export default {
  LUNA_SIGNAL_OUTCOME_CONFIRM,
  loadSignalOutcomeCandidates,
  runLunaSignalOutcomeEval,
};
