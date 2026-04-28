// @ts-nocheck

import { ACTIONS, ANALYST_TYPES } from './signal.ts';

const DEFAULT_WEIGHTS = {
  binance: { '1m': 0.05, '5m': 0.1, '15m': 0.15, '1h': 0.25, '4h': 0.25, '1d': 0.2 },
  kis: { '1m': 0, '5m': 0, '15m': 0, '1h': 0.35, '4h': 0, '1d': 0.65 },
  kis_overseas: { '1m': 0, '5m': 0, '15m': 0, '1h': 0.3, '4h': 0.2, '1d': 0.5 },
};

function actionScore(action = ACTIONS.HOLD) {
  const v = String(action || '').toUpperCase();
  if (v === ACTIONS.BUY) return 1;
  if (v === ACTIONS.SELL) return -1;
  return 0;
}

function clamp(v, min = -1, max = 1) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(min, Math.min(max, n));
}

function extractAriaTimeframes(analyses = []) {
  const aria = analyses.find((row) => row.analyst === ANALYST_TYPES.TA_MTF || row.analyst === ANALYST_TYPES.TA);
  const tf = aria?.metadata?.timeframes;
  if (!tf || typeof tf !== 'object') return {};
  return tf;
}

function normalizeConfiguredTimeframes(value = null) {
  if (!value) return null;
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const frames = raw.map((item) => String(item || '').trim()).filter(Boolean);
  return frames.length > 0 ? new Set(frames) : null;
}

function resolveWeights(exchange = 'binance', options = {}) {
  const base = DEFAULT_WEIGHTS[exchange] || DEFAULT_WEIGHTS.binance;
  const configured = normalizeConfiguredTimeframes(options.timeframes || null);
  if (!configured) return base;

  const filtered = Object.fromEntries(
    Object.entries(base).filter(([tf, weight]) => configured.has(tf) && Number(weight || 0) > 0),
  );
  return Object.keys(filtered).length > 0 ? filtered : base;
}

export function analyzeMultiTimeframe(symbol, analyses = [], exchange = 'binance', options = {}) {
  const weights = resolveWeights(exchange, options);
  const tfData = extractAriaTimeframes(analyses);
  let weighted = 0;
  let total = 0;
  let bullish = 0;
  let bearish = 0;
  const byTimeframe = {};

  for (const [tf, weightRaw] of Object.entries(weights)) {
    const weight = Number(weightRaw || 0);
    if (!(weight > 0)) continue;
    const row = tfData?.[tf] || null;
    const score = actionScore(row?.signal || ACTIONS.HOLD);
    const confidence = Math.max(0, Math.min(1, Number(row?.confidence || 0.5)));
    const contribution = score * confidence * weight;
    weighted += contribution;
    total += weight;
    if (score > 0) bullish++;
    if (score < 0) bearish++;
    byTimeframe[tf] = {
      signal: row?.signal || ACTIONS.HOLD,
      confidence: confidence,
      weight,
      contribution: Number(contribution.toFixed(4)),
    };
  }

  const alignmentScore = total > 0 ? clamp(weighted / total, -1, 1) : 0;
  const dominant = alignmentScore > 0.18 ? ACTIONS.BUY : alignmentScore < -0.18 ? ACTIONS.SELL : ACTIONS.HOLD;
  const mtfAgreement = total > 0 ? Math.max(bullish, bearish) / Math.max(1, bullish + bearish) : 0;

  return {
    symbol,
    exchange,
    alignmentScore: Number(alignmentScore.toFixed(4)),
    mtfAgreement: Number(mtfAgreement.toFixed(4)),
    dominantSignal: dominant,
    bullishFrames: bullish,
    bearishFrames: bearish,
    byTimeframe,
    configuredTimeframes: Object.keys(weights),
  };
}

export default analyzeMultiTimeframe;
