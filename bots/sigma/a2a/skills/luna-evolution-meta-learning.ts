// @ts-nocheck

import { createRequire } from 'node:module';
import { registerSkillHandler } from '../handlers/task-handler.ts';

const require = createRequire(import.meta.url);
const pgPool = require('../../../../packages/core/lib/pg-pool');

async function fetchRows(days = 14, limit = 50) {
  const [actions, failures, facts] = await Promise.all([
    pgPool.query('investment', `
      SELECT parameter_name, reason, metadata, applied_at
        FROM investment.feedback_to_action_map
       WHERE applied_at >= NOW() - ($1::int * INTERVAL '1 day')
       ORDER BY applied_at DESC
       LIMIT $2
    `, [days, limit]).catch(() => []),
    pgPool.query('investment', `
      SELECT id, trade_id, hindsight, avoid_pattern, created_at
        FROM investment.luna_failure_reflexions
       WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
       ORDER BY created_at DESC
       LIMIT $2
    `, [days, limit]).catch(() => []),
    pgPool.query('sigma', `
      SELECT entity, entity_type, fact, confidence, updated_at
        FROM sigma.entity_facts
       WHERE team = 'luna'
       ORDER BY updated_at DESC
       LIMIT $1
    `, [limit]).catch(() => []),
  ]);
  return { actions, failures, facts };
}

function summarize(rows) {
  const actionCounts = rows.actions.reduce((acc, row) => {
    const key = row.parameter_name || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return {
    actionCounts,
    failureReflexions: rows.failures.length,
    sigmaFacts: rows.facts.length,
    recommendations: [
      rows.failures.length > rows.actions.length ? 'failure reflexion 대비 feedback action 전환율을 높입니다.' : null,
      rows.facts.length === 0 ? 'sigma.entity_facts Luna feed 활성화가 필요합니다.' : null,
      Object.keys(actionCounts).length > 3 ? '파라미터 액션이 분산되어 있으므로 주간 우선순위 상위 3개로 압축합니다.' : null,
    ].filter(Boolean),
  };
}

export function registerLunaEvolutionMetaLearningSkill() {
  registerSkillHandler('luna-evolution-meta-learning', async (params) => {
    const p = params || {};
    const rows = await fetchRows(Math.max(1, Number(p.days || 14)), Math.max(1, Number(p.limit || 50)));
    return {
      id: '',
      status: 'completed',
      output: {
        skill: 'luna-evolution-meta-learning',
        analyzedAt: new Date().toISOString(),
        ...summarize(rows),
        details: p.includeDetails === true ? rows : undefined,
      },
    };
  });
}
