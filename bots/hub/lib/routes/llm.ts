const pgPool = require('../../../../packages/core/lib/pg-pool');
const { callClaudeCodeOAuth } = require('../llm/claude-code-oauth');
const { callGroqFallback } = require('../llm/groq-fallback');
const { callWithFallback } = require('../llm/unified-caller');
const { loadGroqAccounts } = require('../llm/secrets-loader');
const { getLlmAdmissionState } = require('../llm/admission-control');
const {
  createLlmJob,
  readJob,
  listLlmJobs,
  getJobStoreState,
} = require('../llm/job-store');
const { parseLlmCallPayload } = require('../llm/request-schema');
const { getAllCircuitStatuses, resetCircuit, resetAllCircuits } = require('../../../../packages/core/lib/local-circuit-breaker');
const {
  getProviderCooldownSnapshot,
  resetProviderCooldown,
} = require('../../../../packages/core/lib/llm-fallback');
const { getProviderStats, resetProviderCircuit, resetAllProviderCircuits } = require('../llm/provider-registry');

// POST /hub/llm/call — Primary(Claude Code OAuth) + Fallback(Groq) 체인
export async function llmCallRoute(req, res) {
  const context = req.hubRequestContext || {};
  const parsed = parseLlmCallPayload(req.body);
  if (!parsed.ok) {
    return res.status(400).json({
      ok: false,
      error: parsed.error,
      traceId: context.traceId || null,
    });
  }
  const body = parsed.data;
  const normalizedRequest = {
    ...body,
    callerTeam: body.callerTeam || context.callerTeam || undefined,
    agent: body.agent || context.agent || undefined,
    urgency: body.urgency || context.priority || undefined,
    traceId: context.traceId || undefined,
  };

  try {
    const resp = await callWithFallback(normalizedRequest);

    logRouting(resp, normalizedRequest).catch((err) =>
      console.error('[llm] routing log 기록 실패:', err.message)
    );

    const providerBackpressure = buildProviderBackpressure(resp);
    if (providerBackpressure?.retryAfterMs) {
      res.set('Retry-After', String(Math.max(1, Math.ceil(providerBackpressure.retryAfterMs / 1000))));
    }

    return res.json({
      ...resp,
      traceId: context.traceId || null,
      admission: {
        queued: Boolean(res.locals?.llmAdmissionQueued),
      },
      ...(providerBackpressure ? { providerBackpressure } : {}),
    });
  } catch (err) {
    const providerBackpressure = buildProviderBackpressure({ error: err.message });
    if (providerBackpressure?.retryAfterMs) {
      res.set('Retry-After', String(Math.max(1, Math.ceil(providerBackpressure.retryAfterMs / 1000))));
    }
    return res.status(500).json({
      ok: false,
      provider: 'failed',
      durationMs: 0,
      error: err.message,
      traceId: context.traceId || null,
      ...(providerBackpressure ? { providerBackpressure } : {}),
    });
  }
}

// POST /hub/llm/jobs — 비동기 LLM job 생성
export async function llmJobsCreateRoute(req, res) {
  const context = req.hubRequestContext || {};
  const parsed = parseLlmCallPayload(req.body);
  if (!parsed.ok) {
    return res.status(400).json({
      ok: false,
      error: parsed.error,
      traceId: context.traceId || null,
    });
  }
  const body = parsed.data;
  const normalizedRequest = {
    ...body,
    callerTeam: body.callerTeam || context.callerTeam || undefined,
    agent: body.agent || context.agent || undefined,
    urgency: body.urgency || context.priority || undefined,
    traceId: context.traceId || undefined,
  };
  const job = await createLlmJob(normalizedRequest, context, { source: 'api' });
  return res.status(202).json({
    ok: true,
    jobId: job.id,
    status: job.status,
    traceId: context.traceId || null,
    statusUrl: `/hub/llm/jobs/${job.id}`,
    resultUrl: `/hub/llm/jobs/${job.id}/result`,
  });
}

// GET /hub/llm/jobs — 최근 비동기 LLM job 목록
export async function llmJobsListRoute(req, res) {
  const limit = Math.min(Math.max(Number(req.query?.limit ?? 20), 1), 100);
  return res.json({
    ok: true,
    jobs: await listLlmJobs(limit),
    store: await getJobStoreState(),
  });
}

// GET /hub/llm/jobs/:id — 비동기 LLM job 상태/결과 조회
export async function llmJobStatusRoute(req, res) {
  const job = await readJob(req.params?.id);
  if (!job) return res.status(404).json({ ok: false, error: 'llm_job_not_found' });
  return res.json({
    ok: true,
    job: redactJobPayload(job),
  });
}

// GET /hub/llm/jobs/:id/result — 완료된 비동기 LLM job 결과만 조회
export async function llmJobResultRoute(req, res) {
  const job = await readJob(req.params?.id);
  if (!job) return res.status(404).json({ ok: false, error: 'llm_job_not_found' });
  if (job.status !== 'completed') {
    return res.status(202).json({
      ok: false,
      status: job.status,
      jobId: job.id,
      retryAfterMs: job.retryAfterMs || 1_000,
    });
  }
  return res.json({
    ok: true,
    jobId: job.id,
    result: job.result,
  });
}

// POST /hub/llm/oauth — Claude Code OAuth 단독 호출
export async function llmOAuthRoute(req, res) {
  if (!directProviderRoutesEnabled()) {
    return res.status(403).json({
      ok: false,
      error: 'direct_llm_provider_route_disabled',
      message: 'Use /hub/llm/call with callerTeam + agent or selectorKey.',
    });
  }
  const body = req.body ?? {};
  if (!body.prompt || typeof body.prompt !== 'string') {
    return res.status(400).json({ error: 'prompt (string) required' });
  }

  try {
    const resp = await callClaudeCodeOAuth({
      prompt: body.prompt,
      model: body.model,
      systemPrompt: body.systemPrompt,
      jsonSchema: body.jsonSchema,
      timeoutMs: body.timeoutMs ?? 60_000,
      maxBudgetUsd: body.maxBudgetUsd,
    });
    return res.json(resp);
  } catch (err) {
    return res.status(500).json({ ok: false, provider: 'failed', durationMs: 0, error: err.message });
  }
}

// POST /hub/llm/groq — Groq 단독 호출
export async function llmGroqRoute(req, res) {
  if (!directProviderRoutesEnabled()) {
    return res.status(403).json({
      ok: false,
      error: 'direct_llm_provider_route_disabled',
      message: 'Use /hub/llm/call with callerTeam + agent or selectorKey.',
    });
  }
  const body = req.body ?? {};
  if (!body.prompt || typeof body.prompt !== 'string') {
    return res.status(400).json({ error: 'prompt (string) required' });
  }

  try {
    const resp = await callGroqFallback({
      prompt: body.prompt,
      model: body.model,
      systemPrompt: body.systemPrompt,
      maxTokens: body.maxTokens,
      temperature: body.temperature,
    });
    return res.json(resp);
  } catch (err) {
    return res.status(500).json({ ok: false, provider: 'failed', durationMs: 0, error: err.message });
  }
}

// GET /hub/llm/stats — provider × team × agent 다차원 집계
export async function llmStatsRoute(req, res) {
  const hours = Math.min(Math.max(Number(req.query?.hours ?? 24), 1), 168);
  const team = req.query?.team;

  const teamFilter = team ? 'AND caller_team = $2' : '';
  const params = team ? [hours, team] : [hours];

  try {
    const [summaryRes, byAgentRes, byHourRes] = await Promise.all([
      pgPool.query('public', `
        SELECT
          provider,
          caller_team,
          COUNT(*)                                                AS total_calls,
          SUM(CASE WHEN success THEN 1 ELSE 0 END)               AS success_count,
          ROUND(AVG(duration_ms))::integer                       AS avg_duration_ms,
          MAX(duration_ms)                                       AS max_duration_ms,
          ROUND(SUM(cost_usd)::numeric, 6)                       AS total_cost_usd,
          COUNT(DISTINCT agent)                                  AS unique_agents,
          SUM(fallback_count)                                    AS total_fallbacks
        FROM llm_routing_log
        WHERE created_at > NOW() - ($1 || ' hours')::interval ${teamFilter}
        GROUP BY provider, caller_team
        ORDER BY total_calls DESC
      `, params),
      pgPool.query('public', `
        SELECT agent, provider,
          COUNT(*)                                               AS calls,
          ROUND(AVG(duration_ms))::integer                      AS avg_ms,
          ROUND(SUM(cost_usd)::numeric, 6)                      AS cost
        FROM llm_routing_log
        WHERE created_at > NOW() - ($1 || ' hours')::interval ${teamFilter}
          AND agent IS NOT NULL
        GROUP BY agent, provider
        ORDER BY calls DESC
        LIMIT 20
      `, params),
      pgPool.query('public', `
        SELECT
          date_trunc('hour', created_at)                        AS hour,
          provider,
          COUNT(*)                                              AS calls,
          ROUND(SUM(cost_usd)::numeric, 6)                     AS cost
        FROM llm_routing_log
        WHERE created_at > NOW() - ($1 || ' hours')::interval ${teamFilter}
        GROUP BY hour, provider
        ORDER BY hour DESC
      `, params),
    ]);

    const summary = summaryRes;
    const totalCalls = summary.reduce((s, r) => s + Number(r.total_calls), 0);
    const totalCost = summary.reduce((s, r) => s + Number(r.total_cost_usd || 0), 0);
    const totalSuccess = summary.reduce((s, r) => s + Number(r.success_count), 0);

    return res.json({
      ok: true,
      hours,
      team: team || 'all',
      groq_pool_size: loadGroqAccounts().length,
      summary,
      by_agent: byAgentRes,
      by_hour: byHourRes,
      totals: {
        total_calls: totalCalls,
        total_cost_usd: totalCost,
        success_rate: totalCalls > 0 ? totalSuccess / totalCalls : 0,
        provider_share: computeProviderShare(summary),
      },
      admission: getLlmAdmissionState(),
      jobs: await getJobStoreState(),
    });
  } catch (err) {
    return res.json({
      ok: true,
      hours,
      team: team || 'all',
      groq_pool_size: loadGroqAccounts().length,
      summary: [],
      by_agent: [],
      by_hour: [],
      totals: { total_calls: 0, total_cost_usd: 0, success_rate: 0, provider_share: {} },
      admission: getLlmAdmissionState(),
      jobs: await getJobStoreState(),
      note: err.message.includes('does not exist') ? 'llm_routing_log 테이블 미생성 — 마이그레이션 필요' : undefined,
    });
  }
}

// GET /hub/llm/load-tests — 최근 부하 테스트 결과 조회
export async function llmLoadTestsRoute(req, res) {
  const limit = Math.min(Math.max(Number(req.query?.limit ?? 20), 1), 100);
  const scenario = req.query?.scenario;
  const whereClause = scenario ? 'WHERE scenario = $1' : '';
  const params = scenario ? [scenario, limit] : [limit];

  try {
    const [rows, scenarioRows] = await Promise.all([
      pgPool.query('public', `
        SELECT
          id,
          run_at,
          scenario,
          total_requests,
          failed_requests,
          fail_rate,
          p95_latency_ms AS p95_ms,
          p99_latency_ms AS p99_ms,
          avg_latency_ms AS avg_ms,
          duration_s,
          notes
        FROM hub.load_test_results
        ${whereClause}
        ORDER BY run_at DESC
        LIMIT $${params.length}
      `, params),
      pgPool.query('public', `
        SELECT DISTINCT ON (scenario)
          scenario,
          run_at,
          total_requests,
          failed_requests,
          fail_rate,
          p95_latency_ms AS p95_ms,
          p99_latency_ms AS p99_ms,
          avg_latency_ms AS avg_ms,
          duration_s,
          notes
        FROM hub.load_test_results
        ORDER BY scenario, run_at DESC
      `),
    ]);

    const normalizedRows = rows.map((row) => ({
      ...row,
      notes: parseLoadTestNotes(row.notes),
    }));
    const scenarioSummary = scenarioRows.map((row) => ({
      ...row,
      notes: parseLoadTestNotes(row.notes),
    }));
    const latest = normalizedRows[0] ?? null;
    return res.json({
      ok: true,
      count: normalizedRows.length,
      scenario: scenario || 'all',
      latest,
      scenario_summary: scenarioSummary,
      results: normalizedRows,
    });
  } catch (err) {
    return res.json({
      ok: true,
      count: 0,
      scenario: scenario || 'all',
      latest: null,
      scenario_summary: [],
      results: [],
      note: err.message.includes('does not exist') ? 'hub.load_test_results 테이블 미생성 — 마이그레이션 필요' : err.message,
    });
  }
}

// GET /hub/llm/circuit — local Ollama circuit breaker 상태 조회 + 리셋
export async function llmCircuitRoute(req, res) {
  if (req.method === 'DELETE') {
    const target = req.query?.target;
    const provider = req.query?.provider;
    if (provider) {
      const decoded = decodeURIComponent(provider);
      resetProviderCircuit(decoded);
      const cooldownReset = resetProviderCooldown(decoded);
      return res.json({ ok: true, reset_provider: decoded, reset_cooldowns: cooldownReset.reset });
    }
    if (target) {
      const decoded = decodeURIComponent(target);
      resetCircuit(decoded);
      return res.json({ ok: true, reset: decoded, reset_cooldowns: [] });
    }
    const resetLocal = resetAllCircuits();
    const resetProviders = resetAllProviderCircuits();
    const cooldownReset = resetProviderCooldown();
    return res.json({
      ok: true,
      reset: 'all',
      reset_local_circuits: resetLocal,
      reset_provider_circuits: resetProviders,
      reset_cooldowns: cooldownReset.reset,
    });
  }

  const statuses = getAllCircuitStatuses();
  const providerStats = getProviderStats();
  const providerCooldowns = getProviderCooldownSnapshot();
  const hasOpen = Object.values(statuses).some((s) => s.state === 'OPEN' || s.state === 'HALF_OPEN')
    || Object.values(providerStats).some((s) => s.state === 'OPEN')
    || Object.values(providerCooldowns).some((s) => s.cooling_down);
  return res.json({
    ok: true,
    local_llm_circuits: statuses,
    provider_circuits: providerStats,
    provider_cooldowns: providerCooldowns,
    any_open: hasOpen,
  });
}

function directProviderRoutesEnabled() {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(process.env.HUB_ALLOW_DIRECT_LLM_PROVIDER_ROUTES || '').trim().toLowerCase());
}

function computeProviderShare(rows) {
  const total = rows.reduce((s, r) => s + Number(r.total_calls), 0);
  if (total === 0) return {};
  const share = {};
  for (const r of rows) {
    share[r.provider] = (share[r.provider] || 0) + Number(r.total_calls) / total;
  }
  return share;
}

function parseLoadTestNotes(notes) {
  if (!notes || typeof notes !== 'string') return notes;
  try {
    return JSON.parse(notes);
  } catch {
    return notes;
  }
}

function buildProviderBackpressure(resp) {
  const error = String(resp?.error || '').toLowerCase();
  if (!error) return null;
  const provider = String(resp?.provider || '').trim() || undefined;
  if (error.includes('429') || error.includes('rate limit') || error.includes('quota')) {
    return {
      kind: 'provider_rate_limit',
      provider,
      retryAfterMs: Number(process.env.HUB_LLM_PROVIDER_RETRY_AFTER_MS || 60_000),
      httpStatus: 429,
      provider_cooldowns: getProviderCooldownSnapshot(),
      provider_circuits: getProviderStats(),
    };
  }
  if (error.includes('provider_cooldown')) {
    return {
      kind: 'provider_cooldown',
      provider,
      retryAfterMs: Number(process.env.HUB_LLM_PROVIDER_RETRY_AFTER_MS || 60_000),
      httpStatus: 503,
      provider_cooldowns: getProviderCooldownSnapshot(),
      provider_circuits: getProviderStats(),
    };
  }
  if (error.includes('provider_circuit_open')) {
    return {
      kind: 'provider_circuit_open',
      provider,
      retryAfterMs: Number(process.env.HUB_LLM_CIRCUIT_RETRY_AFTER_MS || 15_000),
      httpStatus: 503,
      provider_cooldowns: getProviderCooldownSnapshot(),
      provider_circuits: getProviderStats(),
    };
  }
  return null;
}

function redactJobPayload(job) {
  const { payload, ...rest } = job;
  return {
    ...rest,
    payloadSummary: job.payloadSummary,
  };
}

async function logRouting(resp, body) {
  await pgPool.run('public', `
    INSERT INTO llm_routing_log (
      created_at, provider, agent, caller_team, abstract_model,
      success, duration_ms, cost_usd, fallback_count, error, session_id
    ) VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  `, [
    resp.provider,
    body.agent ?? null,
    body.callerTeam ?? null,
    body.abstractModel,
    resp.ok,
    resp.durationMs,
    resp.totalCostUsd ?? 0,
    resp.fallbackCount ?? 0,
    resp.error ?? null,
    resp.sessionId ?? body.traceId ?? null,
  ]);
}
