// @ts-nocheck

import { get, run } from './db/core.ts';

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolEnv(name, env = process.env) {
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(String(env?.[name] || '').trim().toLowerCase());
}

export function normalizeHwmMarket(exchange = null) {
  const key = String(exchange || 'binance').trim().toLowerCase();
  if (key === 'kis') return 'domestic';
  if (key === 'kis_overseas') return 'overseas';
  return 'crypto';
}

export function nextHighWaterMark(previous = 0, totalCapital = 0) {
  return Math.max(0, n(previous, 0), n(totalCapital, 0));
}

export function evaluatePeakDrawdown({ totalCapital = 0, highWaterMark = 0, maxPeakDrawdownPct = 0.10 } = {}) {
  const hwm = n(highWaterMark, 0);
  const capital = n(totalCapital, 0);
  const pct = Math.max(0, n(maxPeakDrawdownPct, 0.10));
  if (!(hwm > 0) || !(capital >= 0) || !(pct > 0)) {
    return { wouldTrigger: false, drawdownPct: 0, thresholdCapital: null, highWaterMark: hwm, totalCapital: capital };
  }
  const thresholdCapital = hwm * (1 - pct);
  const drawdownPct = hwm > 0 ? (hwm - capital) / hwm : 0;
  return {
    wouldTrigger: capital <= thresholdCapital,
    drawdownPct,
    thresholdCapital,
    highWaterMark: hwm,
    totalCapital: capital,
    maxPeakDrawdownPct: pct,
  };
}

export async function getCapitalHighWaterMark(exchange = null, options = {}) {
  const market = options.market || normalizeHwmMarket(exchange);
  const row = await (options.getFn || get)(
    `SELECT high_water_mark, observed_at
       FROM capital_high_water_mark
      WHERE market = $1 AND exchange = $2
      ORDER BY observed_at DESC, id DESC
      LIMIT 1`,
    [market, exchange || 'binance'],
  ).catch(() => null);
  return row ? { highWaterMark: n(row.high_water_mark, 0), observedAt: row.observed_at || null, market, exchange: exchange || 'binance' } : null;
}

export async function recordCapitalHighWaterMark({ exchange = 'binance', totalCapital = 0, source = 'capital_manager' } = {}, options = {}) {
  const market = options.market || normalizeHwmMarket(exchange);
  const previous = await getCapitalHighWaterMark(exchange, options);
  const highWaterMark = nextHighWaterMark(previous?.highWaterMark || 0, totalCapital);
  const changed = highWaterMark > n(previous?.highWaterMark, 0);
  if (!changed && options.writeUnchanged !== true) {
    return { skipped: true, changed: false, highWaterMark, previousHighWaterMark: previous?.highWaterMark || 0, market, exchange };
  }
  const result = await (options.runFn || run)(
    `INSERT INTO capital_high_water_mark
       (market, exchange, high_water_mark, total_capital, source, metadata)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [market, exchange, highWaterMark, n(totalCapital, 0), source, JSON.stringify(options.metadata || {})],
  );
  return { skipped: false, changed, highWaterMark, previousHighWaterMark: previous?.highWaterMark || 0, market, exchange, result };
}

export async function buildPeakDrawdownCircuitEvidence({ exchange = 'binance', totalCapital = 0, env = process.env } = {}, options = {}) {
  if (!boolEnv('LUNA_HWM_PEAK_DD_ENABLED', env)) {
    return { enabled: false, wouldTrigger: false, reason: 'hwm_peak_dd_disabled' };
  }
  const stored = await getCapitalHighWaterMark(exchange, options);
  const fallbackHwm = n(options.highWaterMark, 0);
  const highWaterMark = stored?.highWaterMark || fallbackHwm || n(totalCapital, 0);
  const maxPeakDrawdownPct = n(env.LUNA_HWM_MAX_PEAK_DRAWDOWN_PCT, 0.10);
  const evidence = evaluatePeakDrawdown({ totalCapital, highWaterMark, maxPeakDrawdownPct });
  const mode = String(env.LUNA_HWM_PEAK_DD_MODE || 'shadow').trim().toLowerCase() === 'enforce' ? 'enforce' : 'shadow';
  return {
    enabled: true,
    mode,
    ...evidence,
    source: stored ? 'capital_high_water_mark' : 'runtime_total_capital',
    stored,
  };
}

export default {
  normalizeHwmMarket,
  nextHighWaterMark,
  evaluatePeakDrawdown,
  getCapitalHighWaterMark,
  recordCapitalHighWaterMark,
  buildPeakDrawdownCircuitEvidence,
};
