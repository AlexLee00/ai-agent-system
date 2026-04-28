// @ts-nocheck

import * as db from './db.ts';
import { buildPositionScopeKey, recordPositionLifecycleStageEvent } from './lifecycle-contract.ts';
import { resolvePositionLifecycleFlags } from './position-lifecycle-flags.ts';

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSourceType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return 'unknown';
  if (normalized.includes('reddit') || normalized.includes('apewisdom')) return 'community';
  if (normalized.includes('twitter') || normalized.includes('x_')) return 'community';
  if (normalized.includes('news') || normalized.includes('sec') || normalized.includes('dart')) return 'news';
  return normalized;
}

function summarizeEvidence(rows = []) {
  const bySource = {};
  let sentimentWeighted = 0;
  let qualityWeighted = 0;
  let weightSum = 0;
  for (const row of rows) {
    const source = normalizeSourceType(row?.source_type || row?.sourceType);
    const score = n(row?.score, 0);
    const quality = n(row?.source_quality ?? row?.sourceQuality, 0.5);
    const freshness = n(row?.freshness_score ?? row?.freshnessScore, 1);
    const weight = Math.max(0.05, quality * Math.max(0.25, freshness));
    const entry = bySource[source] || { source, count: 0, avgScore: 0, avgQuality: 0, weight: 0 };
    entry.count += 1;
    entry.avgScore += score;
    entry.avgQuality += quality;
    entry.weight += weight;
    bySource[source] = entry;
    sentimentWeighted += score * weight;
    qualityWeighted += quality * weight;
    weightSum += weight;
  }

  const sources = Object.values(bySource).map((item) => ({
    source: item.source,
    count: item.count,
    avgScore: item.count > 0 ? item.avgScore / item.count : 0,
    avgQuality: item.count > 0 ? item.avgQuality / item.count : 0,
    weight: item.weight,
  })).sort((a, b) => b.count - a.count);

  return {
    evidenceCount: rows.length,
    sourceCount: sources.length,
    sources,
    sentimentScore: weightSum > 0 ? sentimentWeighted / weightSum : 0,
    qualityScore: weightSum > 0 ? qualityWeighted / weightSum : 0.5,
  };
}

function buildRefreshQualityAdjustment(summary = {}, qualityFlags = []) {
  let multiplier = 1;
  const reasons = [];
  if (qualityFlags.includes('low_evidence')) {
    multiplier *= 0.85;
    reasons.push('low_evidence');
  }
  if (qualityFlags.includes('low_source_quality')) {
    multiplier *= 0.75;
    reasons.push('low_source_quality');
  }
  if (summary.sentimentScore <= -0.4) {
    multiplier *= 0.8;
    reasons.push('bearish_sentiment');
  }
  return {
    reevaluationWeightMultiplier: Number(Math.max(0.25, Math.min(1, multiplier)).toFixed(4)),
    reasons,
    sourceCount: Number(summary.sourceCount || 0),
    evidenceCount: Number(summary.evidenceCount || 0),
  };
}

export async function refreshPositionSignals({
  exchange = null,
  symbol = null,
  tradeMode = 'normal',
  source = 'runtime_position_signal_refresh',
  limit = 100,
  deps = null,
} = {}) {
  const flags = resolvePositionLifecycleFlags();
  if (!flags.phaseD.enabled) {
    return {
      ok: true,
      enabled: false,
      mode: flags.mode,
      count: 0,
      rows: [],
    };
  }
  const runtimeDeps = deps || {
    getOpenPositions: db.getOpenPositions,
    getRecentExternalEvidence: db.getRecentExternalEvidence,
    insertPositionSignalHistory: db.insertPositionSignalHistory,
    recordLifecycle: recordPositionLifecycleStageEvent,
  };
  const positions = await runtimeDeps.getOpenPositions(exchange || null, false, tradeMode || null).catch(() => []);
  const filtered = positions
    .filter((row) => !symbol || String(row?.symbol || '').toUpperCase() === String(symbol || '').toUpperCase())
    .slice(0, Math.max(1, Number(limit || 100)));
  const rows = [];

  for (const position of filtered) {
    const scopeKey = buildPositionScopeKey(position.symbol, position.exchange, position.trade_mode || 'normal');
    const evidenceRows = await runtimeDeps.getRecentExternalEvidence({
      symbol: position.symbol,
      days: flags.phaseD.refreshEvidenceDays,
      limit: 12,
    }).catch(() => []);
    const summary = summarizeEvidence(evidenceRows);
    const minEvidence = flags.phaseD.minEvidenceCount;
    const qualityFlags = [];
    let attentionType = null;

    if (summary.evidenceCount < minEvidence) {
      qualityFlags.push('low_evidence');
      attentionType = 'signal_refresh_evidence_gap';
    }
    if (summary.sentimentScore <= -0.4) {
      qualityFlags.push('bearish_sentiment');
      attentionType = attentionType || 'signal_refresh_bearish';
    }
    if (summary.qualityScore < 0.35) {
      qualityFlags.push('low_source_quality');
      attentionType = attentionType || 'signal_refresh_low_quality';
    }
    const qualityAdjustment = buildRefreshQualityAdjustment(summary, qualityFlags);

    const history = await runtimeDeps.insertPositionSignalHistory({
      positionScopeKey: scopeKey,
      exchange: position.exchange,
      symbol: position.symbol,
      tradeMode: position.trade_mode || 'normal',
      source,
      eventType: 'signal_refresh',
      confidence: summary.qualityScore,
      sentimentScore: summary.sentimentScore,
      evidenceSnapshot: {
        summary,
        evidenceIds: evidenceRows.map((item) => item.id),
        qualityAdjustment,
      },
      qualityFlags,
    }).catch(() => null);

    await runtimeDeps.recordLifecycle({
      symbol: position.symbol,
      exchange: position.exchange,
      tradeMode: position.trade_mode || 'normal',
      stageId: 'stage_5',
      ownerAgent: 'position_signal_refresh',
      eventType: 'completed',
      inputSnapshot: {
        source,
        evidenceDays: flags.phaseD.refreshEvidenceDays,
      },
      outputSnapshot: {
        signalHistoryId: history?.id || null,
        attentionType,
        evidenceCount: summary.evidenceCount,
        sentimentScore: summary.sentimentScore,
        qualityScore: summary.qualityScore,
        reevaluationWeightMultiplier: qualityAdjustment.reevaluationWeightMultiplier,
      },
      evidenceSnapshot: {
        evidenceSources: summary.sources,
      },
      idempotencyKey: `stage5:signal_refresh:${scopeKey}:${history?.id || 'none'}`,
    }).catch(() => null);

    rows.push({
      exchange: position.exchange,
      symbol: position.symbol,
      tradeMode: position.trade_mode || 'normal',
      positionScopeKey: scopeKey,
      signalHistoryId: history?.id || null,
      attentionType,
      qualityFlags,
      qualityAdjustment,
      summary,
    });
  }

  return {
    ok: true,
    enabled: flags.phaseD.enabled,
    mode: flags.mode,
    count: rows.length,
    rows,
  };
}

export default {
  refreshPositionSignals,
};
