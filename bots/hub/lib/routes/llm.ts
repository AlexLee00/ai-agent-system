const pgPool = require('../../../../packages/core/lib/pg-pool');
const { callClaudeCodeOAuth } = require('../llm/claude-code-oauth');
const { callGroqFallback } = require('../llm/groq-fallback');
const { callWithFallback } = require('../llm/unified-caller');
const { loadGroqAccounts } = require('../llm/secrets-loader');
const { getAllCircuitStatuses, resetCircuit } = require('../../../../packages/core/lib/local-circuit-breaker');

const VALID_ABSTRACT_MODELS = new Set(['anthropic_haiku', 'anthropic_sonnet', 'anthropic_opus']);

// POST /hub/llm/call — Primary(Claude Code OAuth) + Fallback(Groq) 체인
export async function llmCallRoute(req: any, res: any) {
  const body = req.body ?? {};

  if (!body.prompt || typeof body.prompt !== 'string') {
    return res.status(400).json({ error: 'prompt (string) required' });
  }
  if (!VALID_ABSTRACT_MODELS.has(body.abstractModel)) {
    return res.status(400).json({ error: 'abstractModel required: anthropic_haiku | anthropic_sonnet | anthropic_opus' });
  }

  try {
    const resp = await callWithFallback({
      prompt: body.prompt,
      abstractModel: body.abstractModel,
      systemPrompt: body.systemPrompt,
      jsonSchema: body.jsonSchema,
      timeoutMs: body.timeoutMs ?? 60_000,
      maxBudgetUsd: body.maxBudgetUsd,
      agent: body.agent,
      callerTeam: body.callerTeam,
      urgency: body.urgency,
      taskType: body.taskType,
    });

    logRouting(resp, body).catch((err: Error) =>
      console.error('[llm] routing log 기록 실패:', err.message)
    );

    return res.json(resp);
  } catch (err: any) {
    return res.status(500).json({ ok: false, provider: 'failed', durationMs: 0, error: err.message });
  }
}

// POST /hub/llm/oauth — Claude Code OAuth 단독 호출
export async function llmOAuthRoute(req: any, res: any) {
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
  } catch (err: any) {
    return res.status(500).json({ ok: false, provider: 'failed', durationMs: 0, error: err.message });
  }
}

// POST /hub/llm/groq — Groq 단독 호출
export async function llmGroqRoute(req: any, res: any) {
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
  } catch (err: any) {
    return res.status(500).json({ ok: false, provider: 'failed', durationMs: 0, error: err.message });
  }
}

// GET /hub/llm/stats — provider × team × agent 다차원 집계
export async function llmStatsRoute(req: any, res: any) {
  const hours = Math.min(Math.max(Number(req.query?.hours ?? 24), 1), 168);
  const team = req.query?.team as string | undefined;

  const teamFilter = team ? 'AND caller_team = $2' : '';
  const params: any[] = team ? [hours, team] : [hours];

  try {
    const [summaryRes, byAgentRes, byHourRes] = await Promise.all([
      pgPool.query(`
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
      pgPool.query(`
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
      pgPool.query(`
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

    const summary = summaryRes.rows;
    const totalCalls = summary.reduce((s: number, r: any) => s + Number(r.total_calls), 0);
    const totalCost = summary.reduce((s: number, r: any) => s + Number(r.total_cost_usd || 0), 0);
    const totalSuccess = summary.reduce((s: number, r: any) => s + Number(r.success_count), 0);

    return res.json({
      ok: true,
      hours,
      team: team || 'all',
      groq_pool_size: loadGroqAccounts().length,
      summary,
      by_agent: byAgentRes.rows,
      by_hour: byHourRes.rows,
      totals: {
        total_calls: totalCalls,
        total_cost_usd: totalCost,
        success_rate: totalCalls > 0 ? totalSuccess / totalCalls : 0,
        provider_share: computeProviderShare(summary),
      },
    });
  } catch (err: any) {
    return res.json({
      ok: true,
      hours,
      team: team || 'all',
      groq_pool_size: loadGroqAccounts().length,
      summary: [],
      by_agent: [],
      by_hour: [],
      totals: { total_calls: 0, total_cost_usd: 0, success_rate: 0, provider_share: {} },
      note: err.message.includes('does not exist') ? 'llm_routing_log 테이블 미생성 — 마이그레이션 필요' : undefined,
    });
  }
}

// GET /hub/llm/circuit — local Ollama circuit breaker 상태 조회 + 리셋
export async function llmCircuitRoute(req: any, res: any) {
  if (req.method === 'DELETE') {
    const target = req.query?.target as string | undefined;
    if (target) {
      resetCircuit(decodeURIComponent(target));
      return res.json({ ok: true, reset: target });
    }
    return res.status(400).json({ error: 'target query param required for reset' });
  }

  const statuses = getAllCircuitStatuses();
  const hasOpen = Object.values(statuses).some((s: any) => s.state === 'OPEN' || s.state === 'HALF_OPEN');
  return res.json({ ok: true, local_llm_circuits: statuses, any_open: hasOpen });
}

function computeProviderShare(rows: any[]): Record<string, number> {
  const total = rows.reduce((s: number, r: any) => s + Number(r.total_calls), 0);
  if (total === 0) return {};
  const share: Record<string, number> = {};
  for (const r of rows) {
    share[r.provider] = (share[r.provider] || 0) + Number(r.total_calls) / total;
  }
  return share;
}

async function logRouting(resp: any, body: any): Promise<void> {
  await pgPool.query(`
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
    resp.sessionId ?? null,
  ]);
}
