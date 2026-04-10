// @ts-nocheck
import * as db from '../shared/db.ts';
import { fetchNodeArtifacts } from '../shared/node-runner.ts';
import { getNodeRunsForSymbol, getPipelineRun } from '../shared/pipeline-db.ts';
import { ANALYST_TYPES } from '../shared/signal.ts';

const ANALYST_BY_NODE = {
  L02: ANALYST_TYPES.TA_MTF,
  L03: ANALYST_TYPES.SENTINEL,
  L05: ANALYST_TYPES.ONCHAIN,
};

const COLLECT_NODE_IDS = ['L02', 'L03', 'L05'];
const _pipelineRunCache = new Map();
const _sessionCollectCache = new Map();

export async function loadNodePayloads(sessionId, nodeIds, symbol) {
  const results = [];
  for (const nodeId of nodeIds) {
    const fromArtifact = await fetchNodeArtifacts(sessionId, nodeId, { symbol, limit: 1 }).catch(() => []);
    if (fromArtifact[0]?.payload) {
      results.push({ nodeId, payload: fromArtifact[0].payload, ref: fromArtifact[0].ref, metadata: fromArtifact[0].metadata });
      continue;
    }

    const fallback = await loadLatestNodePayloadFromRuns(sessionId, nodeId, symbol);
    if (fallback?.payload) {
      results.push({ nodeId, payload: fallback.payload, ref: fallback.ref, metadata: fallback.metadata });
    }
  }
  return results;
}

export async function loadLatestNodePayload(sessionId, nodeId, symbol) {
  const hits = await fetchNodeArtifacts(sessionId, nodeId, { symbol, limit: 1 }).catch(() => []);
  if (hits[0]?.payload) return hits[0];
  return loadLatestNodePayloadFromRuns(sessionId, nodeId, symbol);
}

export async function loadAnalysesForSession(sessionId, symbol, market) {
  const artifacts = await loadNodePayloads(sessionId, ['L02', 'L03', 'L05'], symbol);
  const fromArtifacts = artifacts
    .flatMap(item => normalizeAnalysisPayloads(item.nodeId, item.payload, symbol, market))
    .filter(Boolean);

  if (fromArtifacts.length > 0) {
    return { analyses: fromArtifacts, source: 'artifacts', artifacts };
  }

  const sessionCollect = await getSessionCollectState(sessionId, symbol);
  if (sessionCollect.hasCollectRuns) {
    const analyses = await db.query(
      `SELECT * FROM analysis
       WHERE symbol = $1 AND exchange = $2
         AND created_at >= to_timestamp($3 / 1000.0)
       ORDER BY created_at DESC`,
      [symbol, market, sessionCollect.startedAt],
    );

    if (analyses.length > 0) {
      return { analyses, source: 'db_current_session', artifacts: [] };
    }

    return {
      analyses: [],
      source: sessionCollect.hasFailedCollectRuns ? 'session_collect_failed' : 'session_collect_empty',
      artifacts: [],
    };
  }

  const analyses = await db.getRecentAnalysis(symbol, 70, market);
  return { analyses, source: 'db', artifacts: [] };
}

export function buildAnalystSignals(analyses = []) {
  const byAnalyst = new Map(analyses.map(item => [item.analyst, item]));
  const getChar = (signal) => !signal ? 'N' : signal.toUpperCase() === 'BUY' ? 'B' : signal.toUpperCase() === 'SELL' ? 'S' : 'N';
  const sentinelSignal = byAnalyst.get(ANALYST_TYPES.SENTINEL)?.signal;
  return [
    `A:${getChar(byAnalyst.get(ANALYST_TYPES.TA_MTF)?.signal)}`,
    `O:${getChar(byAnalyst.get(ANALYST_TYPES.ONCHAIN)?.signal)}`,
    `H:${getChar(byAnalyst.get(ANALYST_TYPES.NEWS)?.signal || sentinelSignal)}`,
    `S:${getChar(byAnalyst.get(ANALYST_TYPES.SENTIMENT)?.signal || sentinelSignal)}`,
  ].join('|');
}

function normalizeAnalysisPayloads(nodeId, payload, symbol, market) {
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload.analyses)) {
    return payload.analyses.map((entry) => ({
      symbol,
      analyst: entry.analyst,
      signal: entry.signal,
      confidence: entry.confidence,
      reasoning: entry.reasoning,
      metadata: entry.metadata || {},
      exchange: market,
    }));
  }
  const analyst = ANALYST_BY_NODE[nodeId];
  if (!analyst) return null;
  return [{
    symbol,
    analyst,
    signal: payload.signal,
    confidence: payload.confidence,
    reasoning: payload.reasoning,
    metadata: extractMetadata(nodeId, payload),
    exchange: market,
  }];
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
    return {
      sentiment: payload.sentiment ?? null,
      combinedScore: payload.combinedScore ?? null,
      community: payload.metadata?.community ?? null,
      news: payload.metadata?.news ?? null,
    };
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

async function getSessionCollectState(sessionId, symbol) {
  const cacheKey = `${sessionId}:${symbol}`;
  if (_sessionCollectCache.has(cacheKey)) return _sessionCollectCache.get(cacheKey);

  const [pipelineRun, nodeRuns] = await Promise.all([
    getCachedPipelineRun(sessionId),
    getNodeRunsForSymbol(sessionId, symbol, COLLECT_NODE_IDS),
  ]);
  const state = {
    startedAt: Number(pipelineRun?.started_at || Date.now()),
    hasCollectRuns: nodeRuns.length > 0,
    hasFailedCollectRuns: nodeRuns.some(row => row.status === 'failed'),
  };
  _sessionCollectCache.set(cacheKey, state);
  return state;
}

async function getCachedPipelineRun(sessionId) {
  if (_pipelineRunCache.has(sessionId)) return _pipelineRunCache.get(sessionId);
  const row = await getPipelineRun(sessionId).catch(() => null);
  _pipelineRunCache.set(sessionId, row);
  return row;
}

async function loadLatestNodePayloadFromRuns(sessionId, nodeId, symbol) {
  if (!symbol) return null;
  const rows = await getNodeRunsForSymbol(sessionId, symbol, [nodeId]);
  const latest = [...rows]
    .filter(row => row.node_id === nodeId)
    .sort((a, b) => Number(b.started_at || 0) - Number(a.started_at || 0))[0];
  const payload = latest?.metadata?.inline_payload ?? null;
  if (!payload) return null;
  return {
    ref: latest.output_ref || null,
    payload,
    metadata: {
      ...(latest.metadata || {}),
      source: 'pipeline_node_runs_inline',
    },
  };
}
