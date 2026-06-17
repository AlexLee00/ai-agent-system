// @ts-nocheck

import {
  evaluateAlphaExpression,
  validateAlphaCandidate,
} from './luna-alpha-factor-expression.ts';

const FUTURE_FIELD_PATTERNS = [
  /^future/i,
  /^forward/i,
  /^next/i,
  /label/i,
];

function dateKey(value: any) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error('alpha_factor_invalid_date');
  return d.toISOString().slice(0, 10);
}

function finite(value: any) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function mean(values: number[]) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stddev(values: number[]) {
  if (values.length < 2) return null;
  const m = mean(values);
  const variance = values.reduce((sum, value) => sum + ((value - m) ** 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function pearsonCorrelation(xs: number[], ys: number[]) {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const x = xs[i] - mx;
    const y = ys[i] - my;
    num += x * y;
    dx += x * x;
    dy += y * y;
  }
  const denom = Math.sqrt(dx * dy);
  return denom > 0 ? num / denom : null;
}

export function rankValues(values: number[]) {
  const sorted = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value);
  const ranks = new Array(values.length).fill(0);
  let i = 0;
  while (i < sorted.length) {
    let j = i + 1;
    while (j < sorted.length && sorted[j].value === sorted[i].value) j += 1;
    const rank = (i + 1 + j) / 2;
    for (let k = i; k < j; k += 1) ranks[sorted[k].index] = rank;
    i = j;
  }
  return ranks;
}

export function spearmanRankCorrelation(xs: number[], ys: number[]) {
  if (xs.length !== ys.length || xs.length < 2) return null;
  return pearsonCorrelation(rankValues(xs), rankValues(ys));
}

function assertNoFutureFeatureFields(row: any) {
  for (const key of Object.keys(row || {})) {
    if (FUTURE_FIELD_PATTERNS.some((pattern) => pattern.test(key))) {
      throw new Error(`alpha_factor_lookahead_field:${key}`);
    }
  }
}

export function buildPointInTimeFactorSamples(candidate: any, rows: any[], options: any = {}) {
  const horizonDays = Number(options.horizonDays ?? 5);
  const parsedCandidate = validateAlphaCandidate(candidate, options);
  const bySymbol = new Map();
  for (const row of rows || []) {
    if (options.rejectFutureFields !== false) assertNoFutureFeatureFields(row);
    const symbol = String(row.symbol || '').trim();
    const close = finite(row.close);
    if (!symbol || close == null) continue;
    const asOfDate = dateKey(row.asOfDate || row.as_of_date || row.date || row.timestamp);
    if (!bySymbol.has(symbol)) bySymbol.set(symbol, []);
    bySymbol.get(symbol).push({ ...row, symbol, asOfDate, close });
  }

  const samples = [];
  for (const [symbol, symbolRows] of bySymbol.entries()) {
    symbolRows.sort((a, b) => a.asOfDate.localeCompare(b.asOfDate));
    for (let i = 0; i + horizonDays < symbolRows.length; i += 1) {
      const current = symbolRows[i];
      const future = symbolRows[i + horizonDays];
      const factorValue = evaluateAlphaExpression(parsedCandidate.expression, current, options);
      if (factorValue == null) continue;
      const forwardReturn = (future.close - current.close) / current.close;
      if (!Number.isFinite(forwardReturn)) continue;
      samples.push({
        symbol,
        asOfDate: current.asOfDate,
        universeAsOf: current.universeAsOf || current.universe_asof || current.asOfDate,
        factorValue,
        forwardReturn,
      });
    }
  }
  return samples;
}

function groupedByDate(samples: any[]) {
  const byDate = new Map();
  for (const sample of samples) {
    if (!byDate.has(sample.asOfDate)) byDate.set(sample.asOfDate, []);
    byDate.get(sample.asOfDate).push(sample);
  }
  return byDate;
}

function deterministicRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function shuffled(values: any[], rand: any) {
  const copy = values.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function crossSectionalMetrics(samples: any[]) {
  const perDate = [];
  for (const [asOfDate, dateSamples] of groupedByDate(samples).entries()) {
    if (dateSamples.length < 2) continue;
    const xs = dateSamples.map((sample) => sample.factorValue);
    const ys = dateSamples.map((sample) => sample.forwardReturn);
    const ic = pearsonCorrelation(xs, ys);
    const rankIc = spearmanRankCorrelation(xs, ys);
    if (ic == null || rankIc == null) continue;
    perDate.push({ asOfDate, ic, rankIc, sampleCount: dateSamples.length });
  }
  return perDate.sort((a, b) => a.asOfDate.localeCompare(b.asOfDate));
}

function permutationPValue(samples: any[], observedRankIc: number | null, options: any = {}) {
  if (observedRankIc == null) return null;
  const iterations = Math.max(0, Math.min(500, Number(options.permutationIterations ?? 64)));
  if (iterations === 0) return null;
  const seed = Number(options.seed ?? 1337);
  const rand = deterministicRandom(seed);
  const byDate = groupedByDate(samples);
  let extreme = 0;
  for (let iter = 0; iter < iterations; iter += 1) {
    const permutedSamples = [];
    for (const [asOfDate, dateSamples] of byDate.entries()) {
      const returns = shuffled(dateSamples.map((sample) => sample.forwardReturn), rand);
      for (let i = 0; i < dateSamples.length; i += 1) {
        permutedSamples.push({ ...dateSamples[i], asOfDate, forwardReturn: returns[i] });
      }
    }
    const perDate = crossSectionalMetrics(permutedSamples);
    const permutedRankIc = mean(perDate.map((row) => row.rankIc));
    if (permutedRankIc != null && Math.abs(permutedRankIc) >= Math.abs(observedRankIc)) {
      extreme += 1;
    }
  }
  return (extreme + 1) / (iterations + 1);
}

export function evaluateAlphaFactorIc(candidate: any, rows: any[], options: any = {}) {
  const parsedCandidate = validateAlphaCandidate(candidate, options);
  const samples = buildPointInTimeFactorSamples(parsedCandidate, rows, options);
  const perDate = crossSectionalMetrics(samples);
  const ic = mean(perDate.map((row) => row.ic));
  const rankIc = mean(perDate.map((row) => row.rankIc));
  const rankIcStd = stddev(perDate.map((row) => row.rankIc));
  const rankIr = rankIcStd && rankIcStd > 0 && rankIc != null ? rankIc / rankIcStd : null;
  const permutationP = permutationPValue(samples, rankIc, options);
  return {
    ok: true,
    candidate: parsedCandidate,
    horizonDays: Number(options.horizonDays ?? 5),
    sampleCount: samples.length,
    dateCount: perDate.length,
    ic,
    rankIc,
    rankIr,
    permutationP,
    perDate,
    universeAsOf: samples.length ? samples[samples.length - 1].universeAsOf : null,
  };
}

export function buildCandidateBacktestRowFromAlpha(metrics: any, options: any = {}) {
  return {
    symbol: `ALPHA:${metrics?.candidate?.name || options.name || 'unknown'}`,
    market: options.market || 'domestic',
    strategy: 'alpha_factor_discovery',
    fresh: true,
    healthy: metrics.sampleCount >= Number(options.minSampleDays ?? 60),
    max_drawdown: 0,
    sharpe_oos_deflated: Number(metrics.rankIr ?? 0),
    dsr: metrics.permutationP == null ? null : Math.max(0, Math.min(1, 1 - metrics.permutationP)),
    pbo: metrics.permutationP,
    total_trades_oos: metrics.sampleCount,
    selection_method: 'alpha_factor_ic',
    robust_selection_enabled: true,
  };
}

export function alphaMetricsPass(metrics: any, thresholds: any = {}) {
  const minIc = Number(thresholds.minIc ?? 0.03);
  const minRankIr = Number(thresholds.minRankIr ?? 0.5);
  const minSampleDays = Number(thresholds.minSampleDays ?? 60);
  const permutationPMax = Number(thresholds.permutationPMax ?? 0.01);
  return (
    Math.abs(Number(metrics.ic ?? 0)) >= minIc
    && Math.abs(Number(metrics.rankIr ?? 0)) >= minRankIr
    && Number(metrics.sampleCount ?? 0) >= minSampleDays
    && Number(metrics.permutationP ?? 1) <= permutationPMax
  );
}
