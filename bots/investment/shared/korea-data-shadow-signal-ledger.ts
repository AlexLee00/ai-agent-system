// @ts-nocheck
// Shadow-only signal ledger for Luna Korea public-data strategies.

import { run } from './db.ts';

export const KOREA_DATA_SHADOW_SIGNAL_CONFIRM = {
  fundamentalQuant: 'luna-fundamental-quant-shadow-signal',
  earningsSurprise: 'luna-earnings-surprise-shadow-signal',
  disclosureEvent: 'luna-disclosure-event-shadow-signal',
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS investment.korea_public_data_shadow_signals (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    strategy            TEXT NOT NULL,
    stock_code          TEXT,
    company_name        TEXT,
    action              TEXT,
    confidence          NUMERIC,
    signal_score        NUMERIC,
    data_health         TEXT,
    source              TEXT DEFAULT 'luna_korea_public_data_shadow',
    evidence            JSONB DEFAULT '{}'::jsonb,
    result              JSONB DEFAULT '{}'::jsonb,
    shadow_only         BOOLEAN DEFAULT TRUE,
    live_order_allowed  BOOLEAN DEFAULT FALSE,
    observed_at         TIMESTAMPTZ DEFAULT NOW(),
    created_at          TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_korea_public_data_shadow_signals_observed
     ON investment.korea_public_data_shadow_signals(observed_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_korea_public_data_shadow_signals_strategy_action
     ON investment.korea_public_data_shadow_signals(strategy, action, observed_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_korea_public_data_shadow_signals_stock
     ON investment.korea_public_data_shadow_signals(stock_code, observed_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_korea_public_data_shadow_signals_evidence
     ON investment.korea_public_data_shadow_signals USING GIN (evidence)`,
];

function text(value, fallback = '') {
  return String(value ?? fallback ?? '').trim();
}

function finite(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 4) {
  const n = finite(value, null);
  return n == null ? null : Number(n.toFixed(digits));
}

function normalizeStockCode(value) {
  const raw = text(value).toUpperCase();
  return raw || null;
}

function commonEvidence(output = {}, extra = {}) {
  return {
    market: output.market || 'domestic',
    dataHealth: output.dataHealth || null,
    source: output.evidence?.source || null,
    shadowOnly: true,
    liveOrderAllowed: false,
    ...extra,
  };
}

function row(strategy, item = {}, output = {}, extraEvidence = {}) {
  return {
    strategy,
    stockCode: normalizeStockCode(item.stockCode || item.stock_code),
    companyName: text(item.companyName || item.company_name) || null,
    action: text(item.action || item.direction || 'observe') || 'observe',
    confidence: round(item.confidence ?? (item.importanceScore != null ? Number(item.importanceScore) / 10 : null), 4),
    signalScore: round(item.signalScore ?? item.importanceScore ?? item.confidence ?? null, 4),
    dataHealth: output.dataHealth || null,
    source: output.evidence?.source || `skill:${output.skill || strategy}`,
    evidence: commonEvidence(output, {
      reasons: item.reasons || [],
      keywords: item.keywords || [],
      scores: item.scores || null,
      reportType: item.reportType || null,
      receiptNo: item.receiptNo || null,
      receiptDate: item.receiptDate || null,
      ...extraEvidence,
    }),
    result: item,
    shadowOnly: true,
    liveOrderAllowed: false,
    observedAt: new Date().toISOString(),
  };
}

export function extractKoreaDataShadowSignals(strategy, result = {}) {
  const output = result.output || result.result?.output || {};
  if (!output || output.shadowOnly !== true || output.liveOrderAllowed === true) return [];
  const normalizedStrategy = text(strategy || output.skill || '').replace(/_/g, '-');
  if (normalizedStrategy === 'fundamental-quant-trading') {
    return (output.recommendations || []).map((item) => row(normalizedStrategy, item, output));
  }
  if (normalizedStrategy === 'earnings-surprise-trading') {
    return output.recommendation ? [row(normalizedStrategy, output.recommendation, output)] : [];
  }
  if (normalizedStrategy === 'disclosure-event-driven') {
    return (output.events || []).map((item) => row(normalizedStrategy, item, output, {
      hubLlmPolicy: output.hubLlmPolicy || null,
    }));
  }
  return [];
}

export async function ensureKoreaDataShadowSignalSchema(runFn = run) {
  for (const statement of SCHEMA) {
    await Promise.resolve(runFn(statement));
  }
}

export async function insertKoreaDataShadowSignals(signals = [], runFn = run) {
  const inserted = [];
  for (const signal of signals || []) {
    const receiptNo = text(signal.evidence?.receiptNo || signal.result?.receiptNo || '');
    const writeResult = await Promise.resolve(runFn(
      `INSERT INTO investment.korea_public_data_shadow_signals
         (strategy, stock_code, company_name, action, confidence, signal_score,
          data_health, source, evidence, result, shadow_only, live_order_allowed, observed_at)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,true,false,$11
        WHERE (
          $12 = ''
          OR NOT EXISTS (
            SELECT 1
              FROM investment.korea_public_data_shadow_signals
             WHERE strategy = $1
               AND COALESCE(evidence->>'receiptNo', result->>'receiptNo', '') = $12
          )
        )
       RETURNING id`,
      [
        signal.strategy,
        signal.stockCode || null,
        signal.companyName || null,
        signal.action || null,
        signal.confidence,
        signal.signalScore,
        signal.dataHealth || null,
        signal.source || 'luna_korea_public_data_shadow',
        JSON.stringify(signal.evidence || {}),
        JSON.stringify(signal.result || {}),
        signal.observedAt || new Date().toISOString(),
        receiptNo,
      ],
    ));
    if (!writeResult || writeResult.rowCount !== 0) inserted.push(signal);
  }
  return inserted;
}

export function summarizeKoreaDataShadowSignals(signals = []) {
  const byStrategy = {};
  const byAction = {};
  for (const signal of signals || []) {
    const strategy = signal.strategy || 'unknown';
    const action = signal.action || 'unknown';
    byStrategy[strategy] = (byStrategy[strategy] || 0) + 1;
    byAction[action] = (byAction[action] || 0) + 1;
  }
  return {
    total: (signals || []).length,
    byStrategy,
    byAction,
    shadowOnly: true,
    liveOrderAllowed: false,
  };
}

export default {
  KOREA_DATA_SHADOW_SIGNAL_CONFIRM,
  extractKoreaDataShadowSignals,
  ensureKoreaDataShadowSignalSchema,
  insertKoreaDataShadowSignals,
  summarizeKoreaDataShadowSignals,
};
