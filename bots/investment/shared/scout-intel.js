import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const eventLake = require('../../../packages/core/lib/event-lake');

function normalizeSymbol(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeSignals(signals = []) {
  return (Array.isArray(signals) ? signals : [])
    .map((item) => ({
      symbol: normalizeSymbol(item?.symbol),
      market: String(item?.market || '').trim() || 'unknown',
      source: String(item?.source || '').trim() || 'unknown',
      score: Number(item?.score || 0),
      label: String(item?.label || '').trim() || '',
      evidence: String(item?.evidence || '').trim() || '',
    }))
    .filter((item) => item.symbol);
}

export async function loadLatestScoutIntel({ minutes = 24 * 60 } = {}) {
  try {
    const rows = await eventLake.search({
      eventType: 'scout_collect',
      team: 'luna',
      botName: 'scout',
      minutes,
      limit: 3,
    });
    if (!Array.isArray(rows) || rows.length === 0) return null;

    const latest = rows[0];
    const metadata = latest.metadata && typeof latest.metadata === 'object'
      ? latest.metadata
      : {};
    const focusSymbols = (Array.isArray(metadata.focusSymbols) ? metadata.focusSymbols : [])
      .map(normalizeSymbol)
      .filter(Boolean);
    const overlapSymbols = (Array.isArray(metadata.overlapSymbols) ? metadata.overlapSymbols : [])
      .map(normalizeSymbol)
      .filter(Boolean);
    const signals = normalizeSignals(metadata.signals);

    return {
      id: latest.id,
      title: String(latest.title || '').trim(),
      message: String(latest.message || '').trim(),
      createdAt: latest.created_at,
      focusSymbols,
      overlapSymbols,
      signals,
      bySymbol: new Map(signals.map((item) => [item.symbol, item])),
    };
  } catch {
    return null;
  }
}

export function getScoutSignalForSymbol(intel, symbol) {
  if (!intel?.bySymbol) return null;
  return intel.bySymbol.get(normalizeSymbol(symbol)) || null;
}

export function boostCandidatesWithScout(candidates = [], intel = null, { market = 'domestic', boost = 1.15 } = {}) {
  if (!intel || !Array.isArray(candidates) || candidates.length === 0) return candidates;

  const scoutSignals = (intel.signals || []).filter((item) => item.market === market);
  if (scoutSignals.length === 0) return candidates;

  const bucket = new Map(candidates.map((item) => [normalizeSymbol(item.symbol), { ...item }]));

  for (const signal of scoutSignals) {
    const existing = bucket.get(signal.symbol);
    if (existing) {
      const sourceNames = Array.isArray(existing.sourceNames) ? existing.sourceNames : [];
      const hadScoutSource = sourceNames.includes('scout');
      if (!hadScoutSource) sourceNames.push('scout');
      existing.sourceNames = sourceNames;
      existing.sourceCount = Number(existing.sourceCount || sourceNames.length || 1) + (hadScoutSource ? 0 : 1);
      existing.scoutScore = signal.score;
      existing.finalScore = Math.round(((Number(existing.finalScore || 0) + boost + signal.score) * 100)) / 100;
      bucket.set(signal.symbol, existing);
      continue;
    }

    bucket.set(signal.symbol, {
      symbol: signal.symbol,
      name: signal.label || signal.symbol,
      price: 0,
      changeRate: 0,
      volume: 0,
      sourceNames: ['scout'],
      sourceCount: 1,
      sourceVotes: boost,
      scoutScore: signal.score,
      finalScore: Math.round((boost + signal.score) * 100) / 100,
    });
  }

  return [...bucket.values()];
}
