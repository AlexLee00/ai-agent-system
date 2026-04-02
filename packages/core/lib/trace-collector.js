'use strict';

const { randomUUID } = require('crypto');
const pgPool = require('./pg-pool');
const { _calcCostForModel } = require('./llm-logger');

const FLUSH_INTERVAL_MS = 5000;
const FLUSH_BATCH_SIZE = 10;

let queue = [];
let flushTimer = null;

function startTrace(agentName, team, taskType) {
  return {
    traceId: randomUUID().replace(/-/g, '').slice(0, 32),
    agentName: agentName || null,
    team: team || null,
    taskType: taskType || null,
    startedAt: Date.now(),
  };
}

function ensureFlushTimer() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flush().catch((error) => {
      console.error('[trace-collector] flush error:', error.message);
    });
  }, FLUSH_INTERVAL_MS);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

function recordGeneration(trace, genData = {}) {
  const inputTokens = Number(genData.inputTokens || 0);
  const outputTokens = Number(genData.outputTokens || 0);
  const record = {
    trace_id: trace?.traceId || randomUUID().replace(/-/g, '').slice(0, 32),
    agent_name: trace?.agentName || null,
    team: trace?.team || null,
    task_type: trace?.taskType || null,
    model: genData.model || null,
    provider: genData.provider || null,
    route: genData.route || null,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: genData.costUsd != null
      ? Number(genData.costUsd || 0)
      : _calcCostForModel(genData.model, inputTokens, outputTokens),
    latency_ms: Number(genData.latencyMs || (trace?.startedAt ? Date.now() - trace.startedAt : 0)),
    status: genData.status || 'success',
    error_message: genData.errorMessage || null,
    fallback_used: Boolean(genData.fallbackUsed),
    fallback_provider: genData.fallbackProvider || null,
    confidence: genData.confidence != null ? Number(genData.confidence) : null,
    quality_score: genData.qualityScore != null ? Number(genData.qualityScore) : null,
  };

  queue.push(record);

  if (queue.length >= FLUSH_BATCH_SIZE) {
    flush().catch((error) => {
      console.error('[trace-collector] flush error:', error.message);
    });
  }

  ensureFlushTimer();
  return record;
}

async function flush() {
  if (!queue.length) return 0;
  const batch = queue.splice(0, queue.length);
  const values = [];
  const placeholders = [];
  let idx = 1;

  for (const row of batch) {
    const cols = [
      row.trace_id,
      row.agent_name,
      row.team,
      row.task_type,
      row.model,
      row.provider,
      row.route,
      row.input_tokens,
      row.output_tokens,
      row.cost_usd,
      row.latency_ms,
      row.status,
      row.error_message,
      row.fallback_used,
      row.fallback_provider,
      row.confidence,
      row.quality_score,
    ];
    placeholders.push(`(${cols.map(() => `$${idx++}`).join(', ')})`);
    values.push(...cols);
  }

  const sql = `
    INSERT INTO agent.traces (
      trace_id, agent_name, team, task_type,
      model, provider, route,
      input_tokens, output_tokens, cost_usd,
      latency_ms, status, error_message,
      fallback_used, fallback_provider,
      confidence, quality_score
    ) VALUES ${placeholders.join(', ')}
  `;

  try {
    await pgPool.run('agent', sql, values);
  } catch (error) {
    console.error(`[trace-collector] batch insert failed (${batch.length}건):`, error.message);
  }

  return batch.length;
}

async function getTraceStats(days = 7) {
  return pgPool.query('agent', `
    SELECT
      date_trunc('day', created_at) AS day,
      provider,
      count(*) AS call_count,
      coalesce(sum(total_tokens), 0) AS total_tokens,
      coalesce(sum(cost_usd), 0) AS total_cost,
      coalesce(avg(latency_ms)::INTEGER, 0) AS avg_latency,
      count(*) FILTER (WHERE status = 'error') AS error_count,
      count(*) FILTER (WHERE status = 'fallback') AS fallback_count
    FROM agent.traces
    WHERE created_at >= NOW() - make_interval(days => $1::int)
    GROUP BY day, provider
    ORDER BY day DESC, provider
  `, [days]);
}

async function getAgentTraceStats(agentName, days = 7) {
  return pgPool.query('agent', `
    SELECT
      date_trunc('day', created_at) AS day,
      count(*) AS call_count,
      coalesce(sum(total_tokens), 0) AS total_tokens,
      coalesce(sum(cost_usd), 0) AS total_cost,
      coalesce(avg(latency_ms)::INTEGER, 0) AS avg_latency,
      count(*) FILTER (WHERE status = 'error') AS error_count,
      count(*) FILTER (WHERE status = 'fallback') AS fallback_count
    FROM agent.traces
    WHERE agent_name = $1
      AND created_at >= NOW() - make_interval(days => $2::int)
    GROUP BY day
    ORDER BY day DESC
  `, [agentName, days]);
}

module.exports = {
  startTrace,
  recordGeneration,
  flush,
  getTraceStats,
  getAgentTraceStats,
};
