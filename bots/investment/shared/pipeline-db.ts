// @ts-nocheck
import { randomUUID } from 'crypto';
import { get, query, run, withTransaction } from './db.ts';

let _pipelineInitPromise = null;

function withSchedulerExecutionMetadata(metadata = {}) {
  const token = String(process.env.LUNA_SCHEDULER_RUN_TOKEN || '').trim();
  const jobName = String(process.env.LUNA_SCHEDULER_JOB_NAME || '').trim();
  if (!token) return metadata || {};
  return {
    ...(metadata || {}),
    schedulerRunToken: token,
    ...(jobName ? { schedulerJobName: jobName } : {}),
  };
}

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
  const effectiveMeta = withSchedulerExecutionMetadata(meta);
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
    JSON.stringify(effectiveMeta),
  ]);
  return sessionId;
}

export async function finishPipelineRun(sessionId, { status = 'completed', meta = null } = {}) {
  await ensurePipelineSchema();
  const row = await get(`SELECT started_at, meta, status FROM pipeline_runs WHERE session_id = ?`, [sessionId]);
  if (!row) return { updated: false, reason: 'not_found' };
  if (row.status && row.status !== 'running') {
    return { updated: false, reason: 'already_terminal', status: row.status };
  }
  const finishedAt = Date.now();
  const durationMs = row?.started_at ? finishedAt - Number(row.started_at) : null;
  const mergedMeta = meta == null
    ? row?.meta ?? null
    : JSON.stringify({ ...(row?.meta || {}), ...(meta || {}) });

  await run(`
    UPDATE pipeline_runs
    SET status = ?, finished_at = ?, duration_ms = ?, meta = COALESCE(?, meta)
    WHERE session_id = ? AND status = 'running'
  `, [status, finishedAt, durationMs, mergedMeta, sessionId]);
  return { updated: true, status };
}

export async function updatePipelineRunMeta(sessionId, meta = {}) {
  await ensurePipelineSchema();
  const row = await get(`SELECT meta FROM pipeline_runs WHERE session_id = ?`, [sessionId]);
  if (!row) return { updated: false, reason: 'not_found' };
  const mergedMeta = { ...(row?.meta || {}), ...(meta || {}) };
  await run(
    `UPDATE pipeline_runs SET meta = ? WHERE session_id = ?`,
    [JSON.stringify(mergedMeta), sessionId],
  );
  return { updated: true };
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
  const effectiveMetadata = withSchedulerExecutionMetadata(metadata);
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
    JSON.stringify(effectiveMetadata),
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

  const result = await run(`
    UPDATE pipeline_node_runs
    SET status = ?, output_ref = ?, finished_at = ?, duration_ms = ?, error = ?, metadata = COALESCE(?, metadata)
    WHERE id = ? AND status = 'running'
  `, [status, outputRef, finishedAt, durationMs, error, mergedMeta, nodeRunId]);
  return { updated: Number(result?.rowCount || 0) > 0, status };
}

export async function abortPipelineRunsBySchedulerToken(runToken, {
  reason = 'scheduler_timeout',
  jobName = null,
} = {}) {
  const token = String(runToken || '').trim();
  if (!token) return { ok: false, reason: 'scheduler_run_token_missing', pipelineRuns: 0, nodeRuns: 0 };
  await ensurePipelineSchema();
  const finishedAt = Date.now();
  const error = String(reason || 'scheduler_timeout').slice(0, 500);
  return withTransaction(async (tx) => {
    const nodeResult = await tx.run(`
      UPDATE pipeline_node_runs AS node
         SET status = 'aborted_timeout',
             finished_at = $1,
             duration_ms = GREATEST(0, $2 - node.started_at),
             error = $3,
             metadata = COALESCE(node.metadata, '{}'::jsonb)
               || jsonb_build_object('schedulerTimeout', true, 'schedulerJobName', $4::text)
       WHERE node.status = 'running'
         AND EXISTS (
           SELECT 1
             FROM pipeline_runs AS pipeline
            WHERE pipeline.session_id = node.session_id
              AND pipeline.status = 'running'
              AND pipeline.meta->>'schedulerRunToken' = $5
         )
    `, [finishedAt, finishedAt, error, jobName, token]);
    const pipelineResult = await tx.run(`
      UPDATE pipeline_runs
         SET status = 'aborted_timeout',
             finished_at = $1,
             duration_ms = GREATEST(0, $2 - started_at),
             meta = COALESCE(meta, '{}'::jsonb)
               || jsonb_build_object(
                 'schedulerTimeout', true,
                 'schedulerTimeoutReason', $3::text,
                 'schedulerJobName', $4::text
               )
       WHERE status = 'running'
         AND meta->>'schedulerRunToken' = $5
    `, [finishedAt, finishedAt, error, jobName, token]);
    return {
      ok: true,
      pipelineRuns: Number(pipelineResult?.rowCount || 0),
      nodeRuns: Number(nodeResult?.rowCount || 0),
    };
  });
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
  updatePipelineRunMeta,
  startNodeRun,
  finishNodeRun,
  abortPipelineRunsBySchedulerToken,
  getPipelineRun,
  getNodeRuns,
  getNodeRunsForSymbol,
};
