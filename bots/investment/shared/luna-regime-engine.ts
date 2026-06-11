// @ts-nocheck

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as db from './db.ts';
import { detectHMMRegime } from './hmm-regime-detector.ts';
import { getMarketRegime } from './market-regime.ts';
import { getParameter } from './luna-parameter-store.ts';
import {
  DEFAULT_PHASE_A_SYMBOLS_BY_MARKET,
  fetchPhaseABars,
  normalizePhaseAMarket,
} from './luna-phase-a-market-data.ts';
import { publishAlert } from './alert-publisher.ts';

export const LUNA_REGIME_MARKET_SYMBOL = '__market__';
export const LUNA_REGIME_STATES = Object.freeze(['bull', 'bear', 'sideways', 'volatile']);
export const LUNA_REGIME_DEFAULTS = Object.freeze({
  transitionAlertThreshold: 0.15,
  transitionAlertLookback: 6,
  transitionAlertCooldownHours: 4,
  transitionAlertDailyLimit: 1,
  lookbackDays: 120,
  timeframe: '1d',
});
export const LUNA_REGIME_PARAM_KEYS = Object.freeze({
  transitionAlertThreshold: 'c2.transition_alert_threshold',
  transitionAlertCooldownHours: 'c2.transition_alert_cooldown_hours',
  transitionAlertDailyLimit: 'c2.transition_alert_daily_limit',
});

const INVESTMENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_REGIME_ALERT_OUTPUT = path.join(INVESTMENT_ROOT, 'output', 'luna-regime-alerts.json');

export const LUNA_REGIME_ENGINE_HISTORY_SCHEMA_SQL = Object.freeze([
  `ALTER TABLE investment.hmm_regime_log
     ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'hmm',
     ADD COLUMN IF NOT EXISTS transition_alert JSONB`,
  `CREATE INDEX IF NOT EXISTS idx_hmm_regime_log_market_sentinel_created
     ON investment.hmm_regime_log(market, created_at DESC)
     WHERE symbol = '${LUNA_REGIME_MARKET_SYMBOL}'`,
]);

export const LUNA_REGIME_CALIBRATION_SCHEMA_SQL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS investment.luna_regime_calibration (
     id              BIGSERIAL PRIMARY KEY,
     market          TEXT NOT NULL,
     as_of_date      DATE NOT NULL,
     brier_hmm       NUMERIC,
     brier_fallback  NUMERIC,
     label           TEXT NOT NULL,
     probs           JSONB NOT NULL DEFAULT '{}'::jsonb,
     created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE (market, as_of_date)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_luna_regime_calibration_market_date
     ON investment.luna_regime_calibration(market, as_of_date DESC)`,
]);

function finite(value: any, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value: any, min = 0, max = 1) {
  return Math.max(min, Math.min(max, finite(value, min)));
}

function round(value: any, digits = 4) {
  const n = finite(value, 0);
  return Number(n.toFixed(digits));
}

function normalizeMarket(market = 'crypto') {
  return normalizePhaseAMarket(market);
}

function defaultSymbolForMarket(market: string) {
  const normalized = normalizeMarket(market);
  return (DEFAULT_PHASE_A_SYMBOLS_BY_MARKET[normalized] || DEFAULT_PHASE_A_SYMBOLS_BY_MARKET.crypto)[0];
}

function fallbackMarketKey(market: string) {
  if (market === 'domestic') return 'kis';
  if (market === 'overseas') return 'kis_overseas';
  return 'binance';
}

function normalizeProbabilities(input: any = {}) {
  const raw = Object.fromEntries(LUNA_REGIME_STATES.map((state) => [state, Math.max(0, finite(input?.[state], 0))]));
  const total = LUNA_REGIME_STATES.reduce((sum, state) => sum + raw[state], 0);
  if (total <= 0) {
    return { bull: 0.25, bear: 0.25, sideways: 0.25, volatile: 0.25 };
  }
  return Object.fromEntries(LUNA_REGIME_STATES.map((state) => [state, round(raw[state] / total, 6)]));
}

function dominantFromProbabilities(probabilities: any = {}) {
  return LUNA_REGIME_STATES
    .map((state) => ({ state, probability: finite(probabilities?.[state], 0) }))
    .sort((a, b) => b.probability - a.probability)[0]?.state || 'sideways';
}

export function mapFallbackRegime(regime: any = 'ranging') {
  const value = String(regime || '').toLowerCase();
  if (value.includes('bull')) return 'bull';
  if (value.includes('bear')) return 'bear';
  if (value.includes('volatile')) return 'volatile';
  return 'sideways';
}

export function fallbackProbabilities(dominant = 'sideways') {
  const normalized = LUNA_REGIME_STATES.includes(dominant) ? dominant : 'sideways';
  const rest = (1 - 0.55) / (LUNA_REGIME_STATES.length - 1);
  return Object.fromEntries(LUNA_REGIME_STATES.map((state) => [state, round(state === normalized ? 0.55 : rest, 6)]));
}

async function numericParameter(key: string, fallback: number, options: any = {}, deps: any = {}) {
  if (options.parameters && Object.prototype.hasOwnProperty.call(options.parameters, key)) {
    return finite(options.parameters[key], fallback);
  }
  try {
    const row = await (deps.getParameter || getParameter)(key, 'global', {
      bypassCache: options.bypassParameterCache === true,
      env: options.env || process.env,
      queryFn: deps.queryFn || options.queryFn || db.query,
    });
    return finite(row?.value, fallback);
  } catch {
    return fallback;
  }
}

export async function loadRegimeEngineParameters(options: any = {}, deps: any = {}) {
  return {
    transitionAlertThreshold: await numericParameter(
      LUNA_REGIME_PARAM_KEYS.transitionAlertThreshold,
      LUNA_REGIME_DEFAULTS.transitionAlertThreshold,
      options,
      deps,
    ),
    transitionAlertCooldownHours: await numericParameter(
      LUNA_REGIME_PARAM_KEYS.transitionAlertCooldownHours,
      LUNA_REGIME_DEFAULTS.transitionAlertCooldownHours,
      options,
      deps,
    ),
    transitionAlertDailyLimit: await numericParameter(
      LUNA_REGIME_PARAM_KEYS.transitionAlertDailyLimit,
      LUNA_REGIME_DEFAULTS.transitionAlertDailyLimit,
      options,
      deps,
    ),
    transitionAlertLookback: Math.max(1, Number(options.transitionAlertLookback || LUNA_REGIME_DEFAULTS.transitionAlertLookback)),
  };
}

async function loadPreviousRegimeRows(market: string, params: any, options: any = {}, deps: any = {}) {
  if (Array.isArray(options.previousRows)) return options.previousRows;
  const queryFn = deps.queryFn || options.queryFn || db.query;
  try {
    return await queryFn(
      `SELECT current_regime, regime_probabilities, source, transition_alert, created_at
         FROM hmm_regime_log
        WHERE symbol = $1
          AND market = $2
        ORDER BY created_at DESC
        LIMIT $3`,
      [LUNA_REGIME_MARKET_SYMBOL, market, Math.max(1, Number(params.transitionAlertLookback || 6))],
    );
  } catch {
    return [];
  }
}

export function buildTransitionAlert(state: any, previousRows: any[] = [], params: any = LUNA_REGIME_DEFAULTS) {
  const previous = previousRows?.[0];
  if (!previous) return null;
  const previousProbabilities = normalizeProbabilities(previous.regime_probabilities || previous.regimeProbabilities || {});
  const previousDominant = mapFallbackRegime(previous.current_regime || previous.currentRegime || dominantFromProbabilities(previousProbabilities));
  const currentDominant = state.dominant;
  const previousProbability = finite(previousProbabilities[currentDominant], 0);
  const currentProbability = finite(state.probabilities?.[currentDominant], 0);
  const delta = round(currentProbability - previousProbability, 6);
  const threshold = finite(params.transitionAlertThreshold, LUNA_REGIME_DEFAULTS.transitionAlertThreshold);
  const dominantChanged = previousDominant !== currentDominant;
  const probabilitySurge = delta >= threshold;
  if (!dominantChanged && !probabilitySurge) return null;
  return {
    type: dominantChanged ? 'dominant_changed' : 'dominant_probability_surge',
    previousDominant,
    currentDominant,
    previousProbability: round(previousProbability, 6),
    currentProbability: round(currentProbability, 6),
    delta,
    threshold,
    createdAt: state.computedAt,
  };
}

async function fallbackRegimeState(market: string, options: any = {}, deps: any = {}, reason = null) {
  const fallback = await (deps.getMarketRegime || getMarketRegime)(fallbackMarketKey(market), options.fallbackSignals || {});
  const dominant = mapFallbackRegime(fallback?.regime || fallback?.bias);
  const probabilities = fallbackProbabilities(dominant);
  return {
    ok: true,
    market,
    probabilities,
    dominant,
    confidence: round(finite(fallback?.confidence, 0.55)),
    transitionMatrix: {},
    transitionAlert: null,
    source: 'fallback',
    reason: reason || fallback?.reason || 'hmm_unavailable_fallback',
    computedAt: new Date(options.now || Date.now()).toISOString(),
    marketData: options.marketData
      ? {
          source: options.marketData.source,
          bars: Array.isArray(options.marketData.bars) ? options.marketData.bars.length : 0,
          error: options.marketData.error || null,
        }
      : null,
    features: {
      fallbackRegime: fallback?.regime || fallback?.bias || null,
      fallbackSummary: fallback?.summary || null,
    },
    shadowOnly: true,
    liveMutation: false,
  };
}

export async function computeRegimeState(market: any = 'crypto', options: any = {}, deps: any = {}) {
  const normalizedMarket = normalizeMarket(market);
  const computedAt = new Date(options.now || Date.now()).toISOString();
  const params = options.params || await loadRegimeEngineParameters(options, deps);
  const marketData = Array.isArray(options.bars)
    ? { bars: options.bars, source: options.marketDataSource || 'provided_bars', error: null }
    : options.fetchBars === false
      ? { bars: [], source: 'market_data_fetch_disabled', error: null }
      : await (deps.fetchPhaseABars || fetchPhaseABars)({
          symbol: options.symbol || defaultSymbolForMarket(normalizedMarket),
          market: normalizedMarket,
          timeframe: options.timeframe || LUNA_REGIME_DEFAULTS.timeframe,
          lookbackDays: options.lookbackDays || LUNA_REGIME_DEFAULTS.lookbackDays,
          getOhlcv: options.getOhlcv,
        });
  const bars = marketData.bars || [];

  let state;
  if (options.forceFallback === true) {
    state = await fallbackRegimeState(normalizedMarket, { ...options, marketData }, deps, 'force_fallback');
  } else {
    const hmm = (deps.detectHMMRegime || detectHMMRegime)({ bars, vix: options.vix }, options.hmm || {});
    if (hmm?.ok) {
      const probabilities = normalizeProbabilities(hmm.regimeProbabilities || {});
      state = {
        ok: true,
        market: normalizedMarket,
        probabilities,
        dominant: mapFallbackRegime(hmm.currentRegime || dominantFromProbabilities(probabilities)),
        confidence: round(hmm.confidence ?? finite(probabilities[dominantFromProbabilities(probabilities)], 0.25)),
        transitionMatrix: hmm.transitionMatrix || {},
        transitionAlert: null,
        source: 'hmm',
        reason: hmm.status || 'hmm_regime_shadow_ready',
        computedAt,
        marketData: {
          source: marketData.source,
          bars: bars.length,
          error: marketData.error || null,
        },
        features: hmm.features || {},
        shadowOnly: true,
        liveMutation: false,
      };
    } else {
      state = await fallbackRegimeState(normalizedMarket, { ...options, marketData }, deps, hmm?.status || marketData.error || 'hmm_not_ready');
    }
  }

  if (options.evaluateTransitionAlert !== false) {
    const previousRows = await loadPreviousRegimeRows(normalizedMarket, params, options, deps);
    state.transitionAlert = buildTransitionAlert(state, previousRows, params);
  }
  return state;
}

export async function computeAllRegimeStates(options: any = {}, deps: any = {}) {
  const params = options.params || await loadRegimeEngineParameters(options, deps);
  const markets = options.markets || ['overseas', 'domestic', 'crypto'];
  const states = [];
  for (const market of markets) {
    states.push(await computeRegimeState(market, { ...options, params }, deps));
  }
  return states;
}

export async function ensureRegimeEngineHistorySchema(runFn = db.run) {
  for (const statement of LUNA_REGIME_ENGINE_HISTORY_SCHEMA_SQL) {
    await runFn(statement);
  }
}

export async function ensureRegimeCalibrationSchema(runFn = db.run) {
  for (const statement of LUNA_REGIME_CALIBRATION_SCHEMA_SQL) {
    await runFn(statement);
  }
}

export async function insertRegimeStateHistory(state: any, runFn = db.run) {
  await ensureRegimeEngineHistorySchema(runFn);
  return runFn(
    `INSERT INTO hmm_regime_log
       (symbol, market, current_regime, regime_probabilities, transition_matrix, confidence, features, source, transition_alert, shadow_only)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::jsonb,$8,$9::jsonb,true)
     RETURNING id`,
    [
      LUNA_REGIME_MARKET_SYMBOL,
      state.market,
      state.dominant,
      JSON.stringify(state.probabilities || {}),
      JSON.stringify(state.transitionMatrix || {}),
      state.confidence ?? null,
      JSON.stringify({
        ...(state.features || {}),
        marketData: state.marketData || null,
        reason: state.reason || null,
      }),
      state.source || 'hmm',
      state.transitionAlert ? JSON.stringify(state.transitionAlert) : null,
    ],
  );
}

function readJsonFile(filePath: string, fallback: any = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function sameUtcDay(a: string, b: string) {
  return String(a || '').slice(0, 10) === String(b || '').slice(0, 10);
}

export function evaluateRegimeAlertPublication(alerts: any[] = [], state: any = {}, params: any = {}, now = new Date()) {
  const cooldownMs = Math.max(0, finite(params.transitionAlertCooldownHours, 4)) * 60 * 60 * 1000;
  const dailyLimit = Math.max(0, Math.floor(finite(params.transitionAlertDailyLimit, 1)));
  const previousAlerts = Array.isArray(state.alerts) ? state.alerts : [];
  const publishable = [];
  const suppressed = [];
  for (const alert of alerts.filter(Boolean)) {
    const lastSameMarket = previousAlerts
      .filter((item) => item.market === alert.market)
      .sort((a, b) => Date.parse(b.publishedAt || b.createdAt || 0) - Date.parse(a.publishedAt || a.createdAt || 0))[0];
    const todayCount = previousAlerts.filter((item) => sameUtcDay(item.publishedAt || item.createdAt, now.toISOString())).length;
    if (lastSameMarket && Date.parse(now.toISOString()) - Date.parse(lastSameMarket.publishedAt || lastSameMarket.createdAt) < cooldownMs) {
      suppressed.push({ ...alert, suppressedReason: 'cooldown' });
      continue;
    }
    if (todayCount + publishable.length >= dailyLimit) {
      suppressed.push({ ...alert, suppressedReason: 'daily_limit' });
      continue;
    }
    publishable.push(alert);
  }
  return { publishable, suppressed };
}

export async function processRegimeAlerts(states: any[] = [], options: any = {}, deps: any = {}) {
  const params = options.params || await loadRegimeEngineParameters(options, deps);
  const outputPath = path.resolve(options.alertOutputPath || DEFAULT_REGIME_ALERT_OUTPUT);
  const now = new Date(options.now || Date.now());
  const alertCandidates = states
    .filter((state) => state?.transitionAlert)
    .map((state) => ({
      ...state.transitionAlert,
      market: state.market,
      source: state.source,
      confidence: state.confidence,
      createdAt: state.transitionAlert.createdAt || state.computedAt,
    }));
  const previous = readJsonFile(outputPath, { alerts: [] });
  const evaluated = evaluateRegimeAlertPublication(alertCandidates, previous, params, now);
  const publishFn = deps.publishAlert || publishAlert;
  const published = [];
  if (options.publish !== false) {
    for (const alert of evaluated.publishable) {
      try {
        const ok = await publishFn({
          from_bot: 'luna-regime-engine',
          team: 'investment',
          event_type: 'luna_regime_transition_alert',
          alert_level: 2,
          title: `Luna regime transition: ${alert.market}`,
          message: `[Luna Regime] ${alert.market} ${alert.previousDominant} -> ${alert.currentDominant} (${alert.type})`,
          payload: alert,
          visibility: 'notify',
          alarm_type: 'report',
          actionability: 'none',
        });
        published.push({ ...alert, published: Boolean(ok), publishedAt: now.toISOString() });
      } catch (error) {
        published.push({
          ...alert,
          published: false,
          publishedAt: now.toISOString(),
          publishError: error?.message || String(error),
        });
      }
    }
  }
  const nextState = {
    ok: true,
    updatedAt: now.toISOString(),
    alerts: [
      ...(Array.isArray(previous.alerts) ? previous.alerts : []).slice(-100),
      ...published,
    ],
    candidates: alertCandidates,
    suppressed: evaluated.suppressed,
    publishable: evaluated.publishable,
  };
  if (options.writeOutput !== false) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(nextState, null, 2)}\n`);
  }
  return { ...nextState, outputPath, publishedCount: published.filter((item) => item.published).length };
}

export function labelRealizedRegimeFromBars(bars = [], options: any = {}) {
  const normalized = (Array.isArray(bars) ? bars : [])
    .filter((bar) => Number.isFinite(Number(bar?.close)) && Number(bar.close) > 0);
  if (normalized.length < 2) {
    return { label: 'sideways', volatile: false, returnPct: 0, realizedVol: 0, reason: 'insufficient_bars' };
  }
  const prev = Number(normalized.at(-2)?.close || normalized[0].close);
  const last = Number(normalized.at(-1).close);
  const returnPct = prev > 0 ? ((last - prev) / prev) * 100 : 0;
  const returns = [];
  for (let i = 1; i < normalized.length; i += 1) {
    returns.push((Number(normalized[i].close) - Number(normalized[i - 1].close)) / Number(normalized[i - 1].close));
  }
  const avg = returns.reduce((sum, value) => sum + value, 0) / Math.max(1, returns.length);
  const realizedVol = Math.sqrt(returns.reduce((sum, value) => sum + (value - avg) ** 2, 0) / Math.max(1, returns.length));
  const bullThreshold = finite(options.bullThresholdPct, 0.5);
  const bearThreshold = finite(options.bearThresholdPct, -0.5);
  const volatileThreshold = finite(options.volatileThreshold, 0.035);
  const label = returnPct > bullThreshold ? 'bull'
    : returnPct < bearThreshold ? 'bear'
      : 'sideways';
  return {
    label,
    volatile: realizedVol >= volatileThreshold,
    returnPct: round(returnPct, 4),
    realizedVol: round(realizedVol, 6),
    reason: 'daily_return_threshold',
  };
}

export function brierScore(probabilities: any = {}, label = 'sideways') {
  const probs = normalizeProbabilities(probabilities);
  const actual = LUNA_REGIME_STATES.includes(label) ? label : 'sideways';
  return round(LUNA_REGIME_STATES.reduce((sum, state) => {
    const target = state === actual ? 1 : 0;
    return sum + (finite(probs[state], 0) - target) ** 2;
  }, 0), 6);
}

export function buildRegimeCalibrationRow({ market, asOfDate, label, hmmProbabilities, fallbackProbabilities: fallback, metadata = {} }) {
  return {
    market: normalizeMarket(market),
    asOfDate,
    label,
    brierHmm: brierScore(hmmProbabilities, label),
    brierFallback: brierScore(fallback, label),
    probs: {
      hmm: normalizeProbabilities(hmmProbabilities),
      fallback: normalizeProbabilities(fallback),
      metadata,
    },
  };
}

export async function insertRegimeCalibration(row: any, runFn = db.run) {
  await ensureRegimeCalibrationSchema(runFn);
  return runFn(
    `INSERT INTO luna_regime_calibration
       (market, as_of_date, brier_hmm, brier_fallback, label, probs)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     ON CONFLICT (market, as_of_date) DO UPDATE SET
       brier_hmm = EXCLUDED.brier_hmm,
       brier_fallback = EXCLUDED.brier_fallback,
       label = EXCLUDED.label,
       probs = EXCLUDED.probs,
       created_at = NOW()
     RETURNING id`,
    [row.market, row.asOfDate, row.brierHmm, row.brierFallback, row.label, JSON.stringify(row.probs || {})],
  );
}

export function formatRegimeDailyLine(rows = []) {
  const byMarket = new Map((rows || []).map((row) => [normalizeMarket(row.market), row]));
  if (byMarket.size === 0) return '레짐: 데이터 없음';
  const parts = [
    ['domestic', 'KR'],
    ['overseas', 'US'],
    ['crypto', 'crypto'],
  ].map(([market, label]) => {
    const row = byMarket.get(market);
    if (!row) return `${label} 없음`;
    const dominant = row.dominant || row.current_regime || row.currentRegime || 'unknown';
    const confidence = row.confidence == null ? 'n/a' : round(row.confidence, 2);
    const source = row.source ? `/${row.source}` : '';
    return `${label} ${dominant}(${confidence}${source})`;
  });
  return `레짐: ${parts.join('·')}`;
}

export const _testOnly = {
  normalizeProbabilities,
  dominantFromProbabilities,
  fallbackMarketKey,
  defaultSymbolForMarket,
};

export default {
  computeRegimeState,
  computeAllRegimeStates,
  insertRegimeStateHistory,
  processRegimeAlerts,
  labelRealizedRegimeFromBars,
  brierScore,
  buildRegimeCalibrationRow,
  insertRegimeCalibration,
  formatRegimeDailyLine,
};
