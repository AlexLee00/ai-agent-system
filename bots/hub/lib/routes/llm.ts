const pgPool = require('../../../../packages/core/lib/pg-pool');
const { callClaudeCodeOAuth } = require('../llm/claude-code-oauth');
const { callGroqFallback } = require('../llm/groq-fallback');
const { callWithFallback } = require('../llm/unified-caller');
const { loadGroqAccounts } = require('../llm/secrets-loader');

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

// GET /hub/llm/stats — provider별 비용/레이턴시 집계
export async function llmStatsRoute(req: any, res: any) {
  const hours = Math.min(Math.max(Number(req.query?.hours ?? 24), 1), 168);

  try {
    const result = await pgPool.query(`
      SELECT
        provider,
        COUNT(*)                                              AS total_calls,
        SUM(CASE WHEN success THEN 1 ELSE 0 END)             AS success_count,
        ROUND(AVG(duration_ms))                              AS avg_duration_ms,
        ROUND(SUM(cost_usd)::numeric, 6)                     AS total_cost_usd,
        COUNT(DISTINCT agent)                                AS unique_agents
      FROM llm_routing_log
      WHERE created_at > NOW() - ($1 || ' hours')::interval
      GROUP BY provider
      ORDER BY total_calls DESC
    `, [hours]);

    return res.json({
      ok: true,
      hours,
      groq_pool_size: loadGroqAccounts().length,
      stats: result.rows,
    });
  } catch (err: any) {
    // llm_routing_log 테이블 미생성 시 빈 결과 반환 (마이그레이션 전)
    return res.json({
      ok: true,
      hours,
      groq_pool_size: loadGroqAccounts().length,
      stats: [],
      note: err.message.includes('does not exist') ? 'llm_routing_log 테이블 미생성 — 마이그레이션 필요' : undefined,
    });
  }
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
