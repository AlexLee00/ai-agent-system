#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  DEFAULT_PHASE_A_SYMBOLS_BY_MARKET,
  fetchPhaseABars,
  normalizePhaseAMarket,
} from '../shared/luna-phase-a-market-data.ts';
import {
  buildRegimeCalibrationRow,
  computeRegimeState,
  ensureRegimeCalibrationSchema,
  fallbackProbabilities,
  insertRegimeCalibration,
  labelRealizedRegimeFromBars,
} from '../shared/luna-regime-engine.ts';

const CONFIRM_TOKEN = 'luna-regime-calibration-shadow';

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function argValue(name: string, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function parseMarkets(value: any) {
  const raw = String(value || 'domestic,overseas,crypto')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return raw.map((market) => normalizePhaseAMarket(market));
}

async function latestRegimeRow(market: string, queryFn = db.query) {
  const rows = await queryFn(
    `SELECT current_regime, regime_probabilities, confidence, source, created_at
       FROM hmm_regime_log
      WHERE symbol = '__market__'
        AND market = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [market],
  ).catch(() => []);
  return rows?.[0] || null;
}

function asOfDateFromBars(bars = []) {
  const last = bars?.at?.(-1);
  const stamp = last?.timestamp || last?.time || last?.date || new Date().toISOString();
  const numeric = Number(stamp);
  if (Number.isFinite(numeric) && numeric > 0) {
    const ms = numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  const parsed = Date.parse(String(stamp));
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

export async function runLunaRegimeCalibration(options: any = {}, deps: any = {}) {
  const markets = parseMarkets(options.markets);
  const dryRun = options.dryRun !== false;
  const write = options.write === true && options.confirm === CONFIRM_TOKEN && !dryRun;
  const queryFn = deps.queryFn || db.query;
  const runFn = deps.runFn || db.run;
  if (write) await ensureRegimeCalibrationSchema(runFn);

  const rows = [];
  const inserted = [];
  for (const market of markets) {
    const symbol = options.symbols?.[market] || DEFAULT_PHASE_A_SYMBOLS_BY_MARKET[market]?.[0];
    const marketData = await (deps.fetchPhaseABars || fetchPhaseABars)({
      symbol,
      market,
      timeframe: options.timeframe || '1d',
      lookbackDays: Number(options.lookbackDays || 30),
      getOhlcv: options.getOhlcv,
    });
    const bars = marketData.bars || [];
    const realized = labelRealizedRegimeFromBars(bars, options.labelOptions || {});
    const existing = await latestRegimeRow(market, queryFn);
    const hmmState = existing
      ? {
          probabilities: existing.regime_probabilities || {},
          dominant: existing.current_regime,
          source: existing.source || 'hmm',
        }
      : await computeRegimeState(market, {
          bars,
          previousRows: [],
          evaluateTransitionAlert: false,
        }, deps);
    const fallbackState = await computeRegimeState(market, {
      bars,
      forceFallback: true,
      previousRows: [],
      evaluateTransitionAlert: false,
    }, deps).catch(() => ({
      probabilities: fallbackProbabilities('sideways'),
      source: 'fallback',
      reason: 'fallback_compute_failed',
    }));
    const row = buildRegimeCalibrationRow({
      market,
      asOfDate: asOfDateFromBars(bars),
      label: realized.label,
      hmmProbabilities: hmmState.probabilities || {},
      fallbackProbabilities: fallbackState.probabilities || fallbackProbabilities('sideways'),
      metadata: {
        realized,
        bars: bars.length,
        symbol,
        marketDataSource: marketData.source,
        hmmSource: hmmState.source || 'hmm',
        fallbackSource: fallbackState.source || 'fallback',
      },
    });
    rows.push(row);
    if (write) {
      const result = await insertRegimeCalibration(row, runFn);
      inserted.push(result?.rows?.[0]?.id || null);
    }
  }

  return {
    ok: true,
    dryRun,
    write,
    inserted,
    rows,
    shadowOnly: true,
    liveMutation: false,
    protectedPidMutation: false,
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runLunaRegimeCalibration({
      dryRun: !hasFlag('write'),
      write: hasFlag('write'),
      confirm: argValue('confirm'),
      markets: argValue('markets'),
    }),
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: '❌ runtime-luna-regime-calibration 실패:',
  });
}
