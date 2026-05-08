// @ts-nocheck
import * as db from './db.ts';
import { ANALYST_TYPES } from './signal.ts';

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseMetadata(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return {};
  }
}

export function getAnalysisReuseTtlMinutes(analyst) {
  const common = positiveNumber(process.env.LUNA_ANALYSIS_REUSE_TTL_MINUTES, null);
  if (analyst === ANALYST_TYPES.SENTIMENT) {
    return positiveNumber(process.env.LUNA_SENTIMENT_REUSE_TTL_MINUTES, common ?? 60);
  }
  if (analyst === ANALYST_TYPES.NEWS) {
    return positiveNumber(process.env.LUNA_NEWS_REUSE_TTL_MINUTES, common ?? 60);
  }
  if (analyst === ANALYST_TYPES.ONCHAIN) {
    return positiveNumber(process.env.LUNA_ONCHAIN_REUSE_TTL_MINUTES, common ?? 20);
  }
  return common ?? 30;
}

export function analysisReuseEnabled() {
  return process.env.LUNA_ANALYSIS_REUSE_ENABLED !== 'false';
}

export function buildReusableAnalysisResult(row, { symbol, exchange, source }) {
  const metadata = parseMetadata(row?.metadata);
  const createdAt = row?.created_at ? new Date(row.created_at).getTime() : NaN;
  const ageMinutes = Number.isFinite(createdAt)
    ? Math.max(0, Math.round((Date.now() - createdAt) / 60_000))
    : null;
  return {
    symbol: row?.symbol || symbol,
    signal: row?.signal || 'HOLD',
    confidence: Number(row?.confidence || 0),
    reasoning: row?.reasoning || 'recent_analysis_reused',
    sentiment: metadata.sentiment || null,
    combinedScore: metadata.combinedScore ?? null,
    fearGreed: metadata.fearGreed ?? null,
    metadata: {
      ...metadata,
      exchange: row?.exchange || exchange,
      reusedAnalysis: true,
      reuseSource: source,
      sourceAnalysisId: row?.id || null,
      sourceCreatedAt: row?.created_at || null,
      ageMinutes,
    },
  };
}

export async function getReusableAnalysis({ symbol, exchange, analyst, ttlMinutes, source }) {
  if (!analysisReuseEnabled()) return null;
  const ttl = positiveNumber(ttlMinutes, getAnalysisReuseTtlMinutes(analyst));
  if (!symbol || !exchange || !analyst || ttl <= 0) return null;

  const rows = await db.getRecentAnalysis(symbol, ttl, exchange).catch(() => []);
  const row = (rows || []).find((item) => item?.analyst === analyst);
  if (!row) return null;
  return buildReusableAnalysisResult(row, { symbol, exchange, source });
}
