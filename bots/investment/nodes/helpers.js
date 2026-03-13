import * as db from '../shared/db.js';
import { fetchNodeArtifacts } from '../shared/node-runner.js';
import { ANALYST_TYPES } from '../shared/signal.js';

const ANALYST_BY_NODE = {
  L02: ANALYST_TYPES.TA_MTF,
  L03: ANALYST_TYPES.NEWS,
  L04: ANALYST_TYPES.SENTIMENT,
  L05: ANALYST_TYPES.ONCHAIN,
};

export async function loadNodePayloads(sessionId, nodeIds, symbol) {
  const results = [];
  for (const nodeId of nodeIds) {
    const hits = await fetchNodeArtifacts(sessionId, nodeId, { symbol, limit: 1 }).catch(() => []);
    if (hits[0]?.payload) {
      results.push({ nodeId, payload: hits[0].payload, ref: hits[0].ref, metadata: hits[0].metadata });
    }
  }
  return results;
}

export async function loadAnalysesForSession(sessionId, symbol, market) {
  const artifacts = await loadNodePayloads(sessionId, ['L02', 'L03', 'L04', 'L05'], symbol);
  const fromArtifacts = artifacts
    .map(item => normalizeAnalysisPayload(item.nodeId, item.payload, symbol, market))
    .filter(Boolean);

  if (fromArtifacts.length > 0) {
    return { analyses: fromArtifacts, source: 'artifacts', artifacts };
  }

  const analyses = await db.getRecentAnalysis(symbol, 70, market);
  return { analyses, source: 'db', artifacts: [] };
}

function normalizeAnalysisPayload(nodeId, payload, symbol, market) {
  if (!payload || typeof payload !== 'object') return null;
  const analyst = ANALYST_BY_NODE[nodeId];
  if (!analyst) return null;
  return {
    symbol,
    analyst,
    signal: payload.signal,
    confidence: payload.confidence,
    reasoning: payload.reasoning,
    metadata: extractMetadata(nodeId, payload),
    exchange: market,
  };
}

function extractMetadata(nodeId, payload) {
  if (nodeId === 'L02') {
    return {
      atrRatio: payload.atrRatio ?? null,
      currentPrice: payload.currentPrice ?? null,
      score: payload.score ?? null,
    };
  }
  if (nodeId === 'L03') {
    return { sentiment: payload.sentiment ?? null };
  }
  if (nodeId === 'L04') {
    return { sentiment: payload.sentiment ?? null, combinedScore: payload.combinedScore ?? null };
  }
  if (nodeId === 'L05') {
    return {
      fearGreed: payload.fearGreed?.value ?? payload.fearGreed ?? null,
      fundingRate: payload.funding?.fundingRate ?? null,
      longShortRatio: payload.lsRatio?.longShortRatio ?? null,
    };
  }
  return {};
}
