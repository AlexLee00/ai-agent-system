// @ts-nocheck
import * as db from './db.ts';

function clamp(value, min = -1, max = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(min, Math.min(max, n));
}

function scoreFromSignal(signal = 'HOLD', confidence = 0.5) {
  const action = String(signal || '').toUpperCase();
  const conf = Math.max(0, Math.min(1, Number(confidence || 0.5)));
  if (action === 'BUY') return conf;
  if (action === 'SELL') return -conf;
  return 0;
}

function scoreFromEvidence(row = {}) {
  const direction = String(row.signal_direction || row.signalDirection || '').trim().toLowerCase();
  const score = clamp(Number(row.score ?? 0), -1, 1);
  if (direction === 'bullish' || direction === 'buy') return Math.abs(score || 0.5);
  if (direction === 'bearish' || direction === 'sell') return -Math.abs(score || 0.5);
  return score;
}

function sourceQualityWeight(source = 'unknown') {
  const normalized = String(source || '').toLowerCase();
  if (normalized.includes('naver_forum')) return 0.3;
  if (normalized.includes('x_cashtag') || normalized.includes('twitter')) return 0.5;
  if (normalized.includes('reddit')) return 0.4;
  if (normalized.includes('sentiment')) return 0.45;
  if (normalized.includes('sentinel')) return 0.4;
  return 0.35;
}

function freshnessWeight(createdAt = null, now = Date.now()) {
  if (!createdAt) return 0.5;
  const ts = new Date(createdAt).getTime();
  if (!Number.isFinite(ts)) return 0.5;
  const ageHours = Math.max(0, (now - ts) / 3600000);
  if (ageHours <= 1) return 1.0;
  if (ageHours <= 4) return 0.9;
  if (ageHours <= 12) return 0.75;
  if (ageHours <= 24) return 0.6;
  return 0.45;
}

export async function scoreCommunitySentiment(symbols = [], {
  exchange = 'binance',
  minutes = 720,
  externalRows = null,
} = {}) {
  const unique = Array.from(new Set((symbols || []).map((s) => String(s || '').trim()).filter(Boolean)));
  if (unique.length <= 0) return [];
  const rows = await db.query(
    `SELECT symbol, analyst, signal, confidence, metadata, created_at
       FROM analysis
      WHERE exchange = $1
        AND symbol = ANY($2::text[])
        AND analyst IN ('sentiment', 'sentinel')
        AND created_at >= now() - INTERVAL '1 minute' * $3
      ORDER BY created_at DESC`,
    [exchange, unique, Math.max(30, Number(minutes || 720))],
  ).catch(() => []);

  const evidenceRows = Array.isArray(externalRows)
    ? externalRows
    : await db.query(
        `SELECT symbol, source_name, signal_direction, score, source_quality, freshness_score, evidence_summary, raw_ref, created_at
           FROM external_evidence_events
          WHERE source_type = 'community'
            AND symbol = ANY($1::text[])
            AND created_at >= now() - INTERVAL '1 minute' * $2
          ORDER BY created_at DESC
          LIMIT $3`,
        [unique, Math.max(30, Number(minutes || 720)), Math.max(20, unique.length * 20)],
      ).catch(() => []);

  const now = Date.now();
  const grouped = new Map();
  for (const symbol of unique) grouped.set(symbol, []);
  for (const row of rows) {
    if (!grouped.has(row.symbol)) continue;
    grouped.get(row.symbol).push(row);
  }
  for (const row of evidenceRows || []) {
    if (!grouped.has(row.symbol)) continue;
    grouped.get(row.symbol).push({
      symbol: row.symbol,
      analyst: 'community_evidence',
      signal: scoreFromEvidence(row) > 0 ? 'BUY' : scoreFromEvidence(row) < 0 ? 'SELL' : 'HOLD',
      confidence: Math.max(0, Math.min(1, Number(row.source_quality || 0.45))),
      metadata: {
        source: row.source_name || 'community_evidence',
        mentions: row.raw_ref?.mentions || row.raw_ref?.mentionCount || 0,
        evidenceSummary: row.evidence_summary || null,
        sourceQuality: row.source_quality ?? null,
        freshnessScore: row.freshness_score ?? null,
      },
      created_at: row.created_at,
    });
  }

  const output = [];
  for (const symbol of unique) {
    const entries = grouped.get(symbol) || [];
    let weightedSum = 0;
    let totalWeight = 0;
    let botNoisePenalty = 0;
    for (const row of entries.slice(0, 20)) {
      const base = scoreFromSignal(row.signal, row.confidence);
      const sourceHint = String(row?.metadata?.source || row.analyst || '');
      const quality = sourceQualityWeight(sourceHint);
      const fresh = freshnessWeight(row.created_at, now);
      const weight = quality * fresh;
      weightedSum += base * weight;
      totalWeight += weight;

      const mentions = Number(row?.metadata?.mentions || row?.metadata?.mentionCount || 0);
      if (mentions > 400 && Math.abs(base) > 0.8) botNoisePenalty += 0.08;
    }
    const sentimentScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
    const confidence = Math.max(0, Math.min(1, totalWeight / Math.max(1, entries.length)));
    const adjusted = clamp(sentimentScore * (1 - Math.min(0.35, botNoisePenalty)));

    output.push({
      symbol,
      sentimentScore: Number(adjusted.toFixed(4)),
      confidence: Number(confidence.toFixed(4)),
      freshnessScore: entries.length > 0 ? Number(freshnessWeight(entries[0].created_at, now).toFixed(4)) : 0.5,
      sourceCount: entries.length,
      botNoisePenalty: Number(botNoisePenalty.toFixed(4)),
    });
  }
  return output;
}

export default scoreCommunitySentiment;
