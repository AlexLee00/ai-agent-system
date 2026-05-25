// @ts-nocheck
// FinBERT-compatible sentiment normalizer with a deterministic lexical fallback.
// Heavy transformer inference remains optional/off-path for live safety.

const POSITIVE_TERMS = [
  'beat', 'beats', 'surprise', 'growth', 'upgrade', 'buyback', 'contract', 'partnership',
  'profit', 'record', 'strong', 'bullish', '상향', '호실적', '성장', '흑자', '수주', '자사주',
  '배당', '인수', '강세', '개선', '증가',
];

const NEGATIVE_TERMS = [
  'miss', 'downgrade', 'loss', 'dilution', 'lawsuit', 'recall', 'weak', 'bearish', 'default',
  '하향', '적자', '소송', '리콜', '유상증자', '희석', '약세', '감소', '부진', '관리종목', '거래정지',
];

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, finite(value, min)));
}

function round(value, digits = 4) {
  return Number(finite(value, 0).toFixed(digits));
}

function normalizeEvidence(input = {}) {
  const raw = Array.isArray(input) ? input : input.events || input.evidence || input.texts || [];
  return raw.map((item) => {
    if (typeof item === 'string') return { text: item, symbol: null, source: 'text' };
    return {
      text: String(item.text || item.title || item.summary || item.report_nm || item.content || ''),
      symbol: item.symbol || item.stock_code || item.stockCode || null,
      source: item.source || item.source_name || item.sourceType || 'unknown',
      createdAt: item.created_at || item.createdAt || null,
    };
  }).filter((item) => item.text.trim());
}

function countTerms(text, terms) {
  const lower = String(text || '').toLowerCase();
  return terms.reduce((sum, term) => sum + (lower.includes(String(term).toLowerCase()) ? 1 : 0), 0);
}

function scoreText(text = '') {
  const positiveHits = countTerms(text, POSITIVE_TERMS);
  const negativeHits = countTerms(text, NEGATIVE_TERMS);
  const net = positiveHits - negativeHits;
  const confidence = clamp((Math.abs(net) + Math.min(3, positiveHits + negativeHits)) / 6, 0.15, 0.95);
  const positive = clamp(0.33 + Math.max(0, net) * 0.22, 0.02, 0.96);
  const negative = clamp(0.33 + Math.max(0, -net) * 0.22, 0.02, 0.96);
  const neutral = clamp(1 - Math.max(positive, negative) * confidence, 0.02, 0.96);
  const total = positive + negative + neutral;
  const scores = {
    positive: round(positive / total),
    negative: round(negative / total),
    neutral: round(neutral / total),
  };
  const sentiment = scores.positive > scores.negative + 0.08
    ? 'positive'
    : scores.negative > scores.positive + 0.08
      ? 'negative'
      : 'neutral';
  return {
    sentiment,
    scores,
    score: round(scores.positive - scores.negative),
    confidence: round(confidence),
    hits: { positive: positiveHits, negative: negativeHits },
    model: 'finbert_lexical_fallback',
  };
}

export function analyzeFinbertSentiment(input = {}, options = {}) {
  const evidence = normalizeEvidence(input);
  const rows = evidence.map((item) => ({ ...item, ...scoreText(item.text) }));
  const byAsset = {};
  for (const row of rows) {
    const key = row.symbol || options.symbol || 'market';
    if (!byAsset[key]) byAsset[key] = [];
    byAsset[key].push(row);
  }
  const assets = Object.fromEntries(Object.entries(byAsset).map(([symbol, items]) => {
    const score = items.reduce((sum, item) => sum + item.score * item.confidence, 0)
      / Math.max(0.0001, items.reduce((sum, item) => sum + item.confidence, 0));
    const confidence = clamp(items.reduce((sum, item) => sum + item.confidence, 0) / Math.max(1, items.length), 0, 1);
    return [symbol, {
      symbol,
      sentiment: score > 0.08 ? 'positive' : score < -0.08 ? 'negative' : 'neutral',
      score: round(score),
      confidence: round(confidence),
      evidenceCount: items.length,
    }];
  }));
  const aggregateScore = Object.values(assets).length
    ? Object.values(assets).reduce((sum, item) => sum + item.score * item.confidence, 0)
      / Math.max(0.0001, Object.values(assets).reduce((sum, item) => sum + item.confidence, 0))
    : 0;
  return {
    ok: true,
    status: rows.length ? 'finbert_sentiment_shadow_ready' : 'finbert_sentiment_empty',
    model: 'finbert_lexical_fallback',
    transformerRequired: false,
    aggregate: {
      sentiment: aggregateScore > 0.08 ? 'positive' : aggregateScore < -0.08 ? 'negative' : 'neutral',
      score: round(aggregateScore),
      confidence: round(Object.values(assets).reduce((sum, item) => sum + item.confidence, 0) / Math.max(1, Object.values(assets).length)),
      evidenceCount: rows.length,
    },
    assets,
    rows,
    shadowOnly: true,
  };
}

export default { analyzeFinbertSentiment };
