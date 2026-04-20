// @ts-nocheck
import { randomUUID } from 'crypto';
import { search as searchRag, store as storeRag } from './rag-client.ts';
import * as pipelineDb from './pipeline-db.ts';
import { createRequire } from 'module';
import { getInvestmentRagRuntimeConfig } from './runtime-config.ts';

const PIPELINE_NAMESPACE = 'rag_operations';
const RAG_RUNTIME = getInvestmentRagRuntimeConfig();
const _require = createRequire(import.meta.url);
const elixirBridge = _require('../../../packages/core/lib/elixir-bridge');

async function enrichBridgeMetadata(meta = {}) {
  if (!meta?.bridge_payload || typeof meta.bridge_payload !== 'string') {
    return meta;
  }
  try {
    const decoded = await elixirBridge.decodeBridgePayload(meta.bridge_payload);
    return {
      ...meta,
      bridge_payload_summary: {
        envelopeType: decoded?.envelope?.message_type || null,
        eventType: decoded?.event?.eventType || null,
        stage: decoded?.event?.metadata?.stage || null,
        symbol: decoded?.event?.metadata?.symbol || null,
        market: decoded?.event?.metadata?.market || null,
        regime: decoded?.regime?.regime || null,
      },
    };
  } catch (error) {
    return {
      ...meta,
      bridge_payload_decode_error: error.message,
    };
  }
}

function artifactRef(sessionId, nodeId, symbol = null) {
  return [sessionId, nodeId, symbol || 'all', randomUUID()].join(':');
}

export async function createPipelineSession({
  pipeline = 'luna_pipeline',
  market,
  symbols = [],
  triggerType = 'manual',
  triggerRef = null,
  meta = {},
} = {}) {
  await pipelineDb.initPipelineSchema();
  return pipelineDb.createPipelineRun({
    pipeline,
    market,
    symbols,
    triggerType,
    triggerRef,
    meta,
  });
}

export async function storeNodeArtifact({
  sessionId,
  nodeId,
  nodeType = 'node',
  market,
  symbol = null,
  status = 'completed',
  payload,
  meta = {},
} = {}) {
  const ref = artifactRef(sessionId, nodeId, symbol);
  const content = JSON.stringify({
    artifact_ref: ref,
    node_id: nodeId,
    node_type: nodeType,
    market,
    symbol,
    status,
    payload,
  });
  try {
    await storeRag(PIPELINE_NAMESPACE, content, {
      artifact_ref: ref,
      session_id: sessionId,
      node_id: nodeId,
      node_type: nodeType,
      market,
      symbol,
      status,
      timestamp: Date.now(),
      ...meta,
    }, 'luna');
    return { ref, stored: true };
  } catch {
    return { ref, stored: false };
  }
}

export async function fetchNodeArtifacts(sessionId, nodeId, { symbol = null, limit = 5 } = {}) {
  const resolvedLimit = Math.max(1, Number(limit || RAG_RUNTIME.nodeArtifactSearch?.defaultLimit || 5));
  const resolvedThreshold = Number(RAG_RUNTIME.nodeArtifactSearch?.threshold ?? 0.65);
  const hits = await searchRag(
    PIPELINE_NAMESPACE,
    `${sessionId} ${nodeId} ${symbol || ''}`.trim(),
    { limit: resolvedLimit, threshold: resolvedThreshold },
    { sourceBot: 'luna' },
  ).catch(() => []);

  return hits.filter(hit => {
    const meta = hit.metadata || {};
    if (meta.session_id !== sessionId) return false;
    if (meta.node_id !== nodeId) return false;
    if (symbol && meta.symbol !== symbol) return false;
    return true;
  }).map(hit => {
    const parsed = safeParseJSON(hit.content);
    return {
      ref: hit.metadata?.artifact_ref || parsed?.artifact_ref || null,
      payload: parsed?.payload ?? null,
      metadata: hit.metadata || {},
      score: hit.score,
      raw: hit,
    };
  });
}

export async function runNode(node, ctx = {}) {
  const {
    sessionId,
    market,
    symbol = null,
    inputRef = null,
    attempt = 1,
    meta = {},
    storeArtifact = true,
  } = ctx;

  const enrichedMeta = await enrichBridgeMetadata(meta);

  const nodeRunId = await pipelineDb.startNodeRun({
    sessionId,
    nodeId: node.id,
    nodeType: node.type || 'node',
    symbol,
    inputRef,
    attempt,
    metadata: enrichedMeta,
  });

  try {
    const startedAt = Date.now();
    const result = await node.run(ctx);
    const artifact = storeArtifact
      ? await storeNodeArtifact({
          sessionId,
          nodeId: node.id,
          nodeType: node.type || 'node',
          market,
          symbol,
          payload: result,
          meta: {
            input_ref: inputRef,
            duration_ms: Date.now() - startedAt,
          },
        })
      : { ref: null, stored: false };

    await pipelineDb.finishNodeRun(nodeRunId, {
      status: 'completed',
      outputRef: artifact.ref,
      metadata: {
        result_summary: summarizeResult(result),
        rag_artifact_stored: artifact.stored,
        artifact_mode: storeArtifact ? 'rag' : 'db_only',
        inline_payload: !artifact.stored ? result : undefined,
      },
    });

    return { nodeRunId, outputRef: artifact.ref, artifactStored: artifact.stored, result };
  } catch (err) {
    await pipelineDb.finishNodeRun(nodeRunId, {
      status: 'failed',
      error: err.message,
    });
    throw err;
  }
}

export async function recordNodeResult(node, ctx = {}, result, status = 'completed') {
  const {
    sessionId,
    market,
    symbol = null,
    inputRef = null,
    attempt = 1,
    meta = {},
    storeArtifact = true,
  } = ctx;

  const enrichedMeta = await enrichBridgeMetadata(meta);

  const nodeRunId = await pipelineDb.startNodeRun({
    sessionId,
    nodeId: node.id,
    nodeType: node.type || 'node',
    symbol,
    inputRef,
    attempt,
    metadata: enrichedMeta,
  });

  const artifact = storeArtifact
    ? await storeNodeArtifact({
        sessionId,
        nodeId: node.id,
        nodeType: node.type || 'node',
        market,
        symbol,
        status,
        payload: result,
        meta: {
          input_ref: inputRef,
          ...enrichedMeta,
        },
      })
    : { ref: null, stored: false };

  await pipelineDb.finishNodeRun(nodeRunId, {
    status,
    outputRef: artifact.ref,
    metadata: {
      result_summary: summarizeResult(result),
      rag_artifact_stored: artifact.stored,
      artifact_mode: storeArtifact ? 'rag' : 'db_only',
      inline_payload: !artifact.stored ? result : undefined,
    },
  });

  return { nodeRunId, outputRef: artifact.ref, artifactStored: artifact.stored, result };
}

function summarizeResult(result) {
  if (Array.isArray(result)) return { kind: 'array', count: result.length };
  if (result && typeof result === 'object') {
    return { kind: 'object', keys: Object.keys(result).slice(0, 10) };
  }
  return { kind: typeof result };
}

function safeParseJSON(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export default {
  PIPELINE_NAMESPACE,
  createPipelineSession,
  storeNodeArtifact,
  fetchNodeArtifacts,
  runNode,
  recordNodeResult,
};
