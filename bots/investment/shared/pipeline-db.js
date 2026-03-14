import { randomUUID } from 'crypto';
import { get, query, run } from './db.js';

let _pipelineInitPromise = null;

async function ensurePipelineSchema() {
  if (_pipelineInitPromise) return _pipelineInitPromise;
  _pipelineInitPromise = (async () => {
    await run(`
      CREATE TABLE IF NOT EXISTS pipeline_runs (
        session_id TEXT PRIMARY KEY,
        pipeline TEXT NOT NULL,
        market TEXT NOT NULL,
        symbols JSONB,
        trigger_type TEXT,
        trigger_ref TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        started_at BIGINT NOT NULL,
        finished_at BIGINT,
        duration_ms BIGINT,
        meta JSONB
      )
    `);
    await run(`CREATE INDEX IF NOT EXISTS idx_pipeline_runs_market ON pipeline_runs(market, started_at DESC)`);

    await run(`
      CREATE TABLE IF NOT EXISTS pipeline_node_runs (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        session_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        node_type TEXT,
        symbol TEXT,
        input_ref TEXT,
        output_ref TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        started_at BIGINT NOT NULL,
        finished_at BIGINT,
        duration_ms BIGINT,
        attempt INTEGER NOT NULL DEFAULT 1,
        error TEXT,
        metadata JSONB
      )
    `);
    await run(`CREATE INDEX IF NOT EXISTS idx_pipeline_nodes_session ON pipeline_node_runs(session_id, started_at)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_pipeline_nodes_node ON pipeline_node_runs(node_id, started_at DESC)`);
  })().catch(err => {
    _pipelineInitPromise = null;
    throw err;
  });
  return _pipelineInitPromise;
}

export async function initPipelineSchema() {
  await ensurePipelineSchema();
}

export async function createPipelineRun({
  pipeline = 'luna_pipeline',
  market,
  symbols = [],
  triggerType = 'manual',
  triggerRef = null,
  meta = {},
} = {}) {
  await ensurePipelineSchema();
  const sessionId = randomUUID();
  const startedAt = Date.now();
  await run(`
    INSERT INTO pipeline_runs (
      session_id, pipeline, market, symbols, trigger_type, trigger_ref,
      status, started_at, meta
    ) VALUES (?,?,?,?,?,?,?,?,?)
  `, [
    sessionId,
    pipeline,
    market,
    JSON.stringify(symbols),
    triggerType,
    triggerRef,
    'running',
    startedAt,
    JSON.stringify(meta || {}),
  ]);
  return sessionId;
}

export async function finishPipelineRun(sessionId, { status = 'completed', meta = null } = {}) {
  await ensurePipelineSchema();
  const row = await get(`SELECT started_at, meta FROM pipeline_runs WHERE session_id = ?`, [sessionId]);
  const finishedAt = Date.now();
  const durationMs = row?.started_at ? finishedAt - Number(row.started_at) : null;
  const mergedMeta = meta == null
    ? row?.meta ?? null
    : JSON.stringify({ ...(row?.meta || {}), ...(meta || {}) });

  await run(`
    UPDATE pipeline_runs
    SET status = ?, finished_at = ?, duration_ms = ?, meta = COALESCE(?, meta)
    WHERE session_id = ?
  `, [status, finishedAt, durationMs, mergedMeta, sessionId]);
}

export async function startNodeRun({
  sessionId,
  nodeId,
  nodeType = 'node',
  symbol = null,
  inputRef = null,
  metadata = {},
  attempt = 1,
} = {}) {
  await ensurePipelineSchema();
  const id = randomUUID();
  await run(`
    INSERT INTO pipeline_node_runs (
      id, session_id, node_id, node_type, symbol, input_ref,
      status, started_at, attempt, metadata
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
  `, [
    id,
    sessionId,
    nodeId,
    nodeType,
    symbol,
    inputRef,
    'running',
    Date.now(),
    attempt,
    JSON.stringify(metadata || {}),
  ]);
  return id;
}

export async function finishNodeRun(nodeRunId, {
  status = 'completed',
  outputRef = null,
  error = null,
  metadata = null,
} = {}) {
  await ensurePipelineSchema();
  const row = await get(`SELECT started_at, metadata FROM pipeline_node_runs WHERE id = ?`, [nodeRunId]);
  const finishedAt = Date.now();
  const durationMs = row?.started_at ? finishedAt - Number(row.started_at) : null;
  const mergedMeta = metadata == null
    ? row?.metadata ?? null
    : JSON.stringify({ ...(row?.metadata || {}), ...(metadata || {}) });

  await run(`
    UPDATE pipeline_node_runs
    SET status = ?, output_ref = ?, finished_at = ?, duration_ms = ?, error = ?, metadata = COALESCE(?, metadata)
    WHERE id = ?
  `, [status, outputRef, finishedAt, durationMs, error, mergedMeta, nodeRunId]);
}

export async function getPipelineRun(sessionId) {
  await ensurePipelineSchema();
  return get(`SELECT * FROM pipeline_runs WHERE session_id = ?`, [sessionId]);
}

export async function getNodeRuns(sessionId) {
  await ensurePipelineSchema();
  return query(`SELECT * FROM pipeline_node_runs WHERE session_id = ? ORDER BY started_at`, [sessionId]);
}

export async function getNodeRunsForSymbol(sessionId, symbol, nodeIds = []) {
  await ensurePipelineSchema();
  if (!symbol) return [];
  const rows = await query(
    `SELECT * FROM pipeline_node_runs WHERE session_id = ? AND symbol = ? ORDER BY started_at`,
    [sessionId, symbol],
  );
  if (!Array.isArray(nodeIds) || nodeIds.length === 0) return rows;
  const allowed = new Set(nodeIds);
  return rows.filter(row => allowed.has(row.node_id));
}

export default {
  initPipelineSchema,
  createPipelineRun,
  finishPipelineRun,
  startNodeRun,
  finishNodeRun,
  getPipelineRun,
  getNodeRuns,
  getNodeRunsForSymbol,
};
