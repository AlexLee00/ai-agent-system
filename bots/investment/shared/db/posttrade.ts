// @ts-nocheck
import { query, run, get } from './core.ts';

export async function fetchPendingPosttradeKnowledgeEvents({ limit = 20 } = {}) {
  const safeLimit = Math.max(1, Math.round(Number(limit || 20)));
  return query(
    `SELECT
       mk.id AS knowledge_id,
       mk.created_at,
       mk.payload,
       CASE WHEN mk.payload->>'trade_id' ~ '^[0-9]+$'
            THEN (mk.payload->>'trade_id')::BIGINT
            ELSE NULL
       END AS trade_id
     FROM investment.mapek_knowledge mk
     WHERE mk.event_type = 'quality_evaluation_pending'
       AND COALESCE(mk.payload->>'posttrade_processed', 'false') <> 'true'
       AND mk.payload->>'trade_id' ~ '^[0-9]+$'
     ORDER BY mk.created_at ASC
     LIMIT $1`,
    [safeLimit],
  ).catch(() => []);
}

export async function markPosttradeKnowledgeEventProcessed(knowledgeId, metadata = {}) {
  if (!knowledgeId) return null;
  const row = await get(
    `UPDATE investment.mapek_knowledge
        SET payload = COALESCE(payload, '{}'::jsonb)
          || jsonb_build_object(
            'posttrade_processed', true,
            'posttrade_processed_at', NOW()::text,
            'posttrade_process_meta', $2::jsonb
          )
      WHERE id = $1
      RETURNING id`,
    [knowledgeId, JSON.stringify(metadata || {})],
  ).catch(() => null);
  return row?.id || null;
}

export async function insertFeedbackToActionMap({
  sourceTradeId = null,
  parameterName,
  oldValue = null,
  newValue = null,
  reason = null,
  suggestionLogId = null,
  metadata = {},
} = {}) {
  if (!parameterName) return null;
  const row = await get(
    `INSERT INTO feedback_to_action_map
       (source_trade_id, parameter_name, old_value, new_value, reason, suggestion_log_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, applied_at`,
    [
      sourceTradeId ? Number(sourceTradeId) : null,
      String(parameterName),
      JSON.stringify(oldValue),
      JSON.stringify(newValue),
      reason || null,
      suggestionLogId || null,
      JSON.stringify(metadata || {}),
    ],
  ).catch(() => null);
  return row || null;
}

export async function recordFeedbackToActionMap(payload = {}) {
  return insertFeedbackToActionMap(payload);
}

export async function getRecentFeedbackToActionMap({ days = 7, market = null, limit = 100 } = {}) {
  const params = [Math.max(1, Math.round(Number(days || 7))), Math.max(1, Math.round(Number(limit || 100)))];
  const clauses = [`fam.applied_at >= NOW() - ($1::int * INTERVAL '1 day')`];
  if (market) {
    params.push(String(market));
    clauses.push(`COALESCE(th.market, CASE WHEN th.exchange = 'binance' THEN 'crypto' WHEN th.exchange = 'kis' THEN 'domestic' ELSE 'overseas' END) = $${params.length}`);
  }
  try {
    return await query(
    `SELECT fam.*, th.symbol, th.exchange, th.market
       FROM feedback_to_action_map fam
       LEFT JOIN investment.trade_history th ON th.id = fam.source_trade_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY fam.applied_at DESC
      LIMIT $2`,
    params,
    );
  } catch (error) {
    const message = String(error?.message || error || '');
    if (message.includes('trade_history') || message.includes('does not exist')) {
      if (market) return [];
      return query(
        `SELECT fam.*
           FROM feedback_to_action_map fam
          WHERE fam.applied_at >= NOW() - ($1::int * INTERVAL '1 day')
          ORDER BY fam.applied_at DESC
          LIMIT $2`,
        [params[0], params[1]],
      ).catch(() => []);
    }
    return [];
  }
}

export async function upsertPosttradeSkill({
  market = 'all',
  agentName = 'all',
  skillType = 'success',
  patternKey,
  title,
  summary,
  invocationCount = 0,
  successRate = 0,
  winCount = 0,
  lossCount = 0,
  sourceTradeIds = [],
  metadata = {},
} = {}) {
  if (!patternKey || !title || !summary) return null;
  const row = await get(
    `INSERT INTO luna_posttrade_skills
       (market, agent_name, skill_type, pattern_key, title, summary, invocation_count, success_rate, win_count, loss_count, source_trade_ids, metadata, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
     ON CONFLICT (market, agent_name, skill_type, pattern_key)
     DO UPDATE SET
       title = EXCLUDED.title,
       summary = EXCLUDED.summary,
       invocation_count = EXCLUDED.invocation_count,
       success_rate = EXCLUDED.success_rate,
       win_count = EXCLUDED.win_count,
       loss_count = EXCLUDED.loss_count,
       source_trade_ids = EXCLUDED.source_trade_ids,
       metadata = EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING id, market, agent_name, skill_type, pattern_key, updated_at`,
    [
      String(market || 'all'),
      String(agentName || 'all'),
      String(skillType || 'success'),
      String(patternKey),
      String(title),
      String(summary),
      Math.max(0, Math.round(Number(invocationCount || 0))),
      Number(successRate || 0),
      Math.max(0, Math.round(Number(winCount || 0))),
      Math.max(0, Math.round(Number(lossCount || 0))),
      JSON.stringify(Array.isArray(sourceTradeIds) ? sourceTradeIds : []),
      JSON.stringify(metadata || {}),
    ],
  ).catch(() => null);
  return row || null;
}

export async function getRecentPosttradeSkills({ market = null, agentName = null, skillType = null, limit = 50 } = {}) {
  const params = [];
  const where = [];
  if (market) {
    params.push(String(market));
    where.push(`market = $${params.length}`);
  }
  if (agentName) {
    params.push(String(agentName));
    where.push(`agent_name = $${params.length}`);
  }
  if (skillType) {
    params.push(String(skillType));
    where.push(`skill_type = $${params.length}`);
  }
  params.push(Math.max(1, Math.round(Number(limit || 50))));
  return query(
    `SELECT *
       FROM luna_posttrade_skills
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY success_rate DESC, updated_at DESC
      LIMIT $${params.length}`,
    params,
  ).catch(() => []);
}

export async function cleanupPosttradeSmokeArtifacts({ apply = false } = {}) {
  const summary = {
    apply: apply === true,
    feedbackToActionRows: 0,
    suggestionLogs: 0,
    posttradeSkills: 0,
    knowledgeRows: 0,
  };

  const suggestionRows = await query(
    `SELECT id
       FROM runtime_config_suggestion_log
      WHERE market_summary->>'smoke' = 'true'
         OR COALESCE(review_note, '') ILIKE '%posttrade audit smoke%'
         OR suggestions::text ILIKE '%runtime_config.posttrade.smoke.%'`,
    [],
  ).catch(() => []);
  const suggestionIds = (suggestionRows || []).map((row) => String(row.id)).filter(Boolean);
  summary.suggestionLogs = suggestionIds.length;

  const feedbackRows = await query(
    `SELECT id
       FROM feedback_to_action_map
      WHERE metadata->>'smoke' = 'true'
         OR parameter_name LIKE 'runtime_config.posttrade.smoke.%'
         OR COALESCE(reason, '') ILIKE '%smoke%'
         OR (${suggestionIds.length > 0 ? 'suggestion_log_id = ANY($1::text[])' : 'false'})`,
    suggestionIds.length > 0 ? [suggestionIds] : [],
  ).catch(() => []);
  summary.feedbackToActionRows = (feedbackRows || []).length;

  const skillRows = await query(
    `SELECT id
       FROM luna_posttrade_skills
      WHERE metadata->>'smoke' = 'true'
         OR pattern_key LIKE '%:smoke_%'
         OR pattern_key LIKE '%:mirror_smoke:%'
         OR summary ILIKE '%smoke%'`,
    [],
  ).catch(() => []);
  summary.posttradeSkills = (skillRows || []).length;

  const knowledgeRows = await query(
    `SELECT id
       FROM investment.mapek_knowledge
      WHERE event_type IN ('quality_evaluation_pending', 'posttrade_quality_evaluated')
        AND (
          payload->>'smoke' = 'true'
          OR payload->>'source' = 'posttrade_smoke'
          OR payload->>'trade_id' LIKE '90%'
        )`,
    [],
  ).catch(() => []);
  summary.knowledgeRows = (knowledgeRows || []).length;

  if (apply !== true) return summary;

  await run(
    `DELETE FROM feedback_to_action_map
      WHERE metadata->>'smoke' = 'true'
         OR parameter_name LIKE 'runtime_config.posttrade.smoke.%'
         OR COALESCE(reason, '') ILIKE '%smoke%'
         OR (${suggestionIds.length > 0 ? 'suggestion_log_id = ANY($1::text[])' : 'false'})`,
    suggestionIds.length > 0 ? [suggestionIds] : [],
  ).catch(() => {});
  await run(
    `DELETE FROM runtime_config_suggestion_log
      WHERE market_summary->>'smoke' = 'true'
         OR COALESCE(review_note, '') ILIKE '%posttrade audit smoke%'
         OR suggestions::text ILIKE '%runtime_config.posttrade.smoke.%'`,
    [],
  ).catch(() => {});
  await run(
    `DELETE FROM luna_posttrade_skills
      WHERE metadata->>'smoke' = 'true'
         OR pattern_key LIKE '%:smoke_%'
         OR pattern_key LIKE '%:mirror_smoke:%'
         OR summary ILIKE '%smoke%'`,
    [],
  ).catch(() => {});
  await run(
    `DELETE FROM investment.mapek_knowledge
      WHERE event_type IN ('quality_evaluation_pending', 'posttrade_quality_evaluated')
        AND (
          payload->>'smoke' = 'true'
          OR payload->>'source' = 'posttrade_smoke'
          OR payload->>'trade_id' LIKE '90%'
        )`,
    [],
  ).catch(() => {});

  return summary;
}
