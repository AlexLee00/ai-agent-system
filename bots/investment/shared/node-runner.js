import { randomUUID } from 'crypto';
import { search as searchRag, store as storeRag } from './rag-client.js';
import * as pipelineDb from './pipeline-db.js';

const PIPELINE_NAMESPACE = 'investment_pipeline_store';

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
  const hits = await searchRag(
    PIPELINE_NAMESPACE,
    `${sessionId} ${nodeId} ${symbol || ''}`.trim(),
    { limit, threshold: 0.65 },
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
  } = ctx;

  const nodeRunId = await pipelineDb.startNodeRun({
    sessionId,
    nodeId: node.id,
    nodeType: node.type || 'node',
    symbol,
    inputRef,
    attempt,
    metadata: meta,
  });

  try {
    const startedAt = Date.now();
    const result = await node.run(ctx);
    const artifact = await storeNodeArtifact({
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
    });

    await pipelineDb.finishNodeRun(nodeRunId, {
      status: 'completed',
      outputRef: artifact.ref,
      metadata: {
        result_summary: summarizeResult(result),
        rag_artifact_stored: artifact.stored,
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
};
