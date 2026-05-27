// @ts-nocheck

import { createRequire } from 'node:module';
import { registerSkillHandler } from '../handlers/task-handler.ts';

const require = createRequire(import.meta.url);
const pgPool = require('../../../../packages/core/lib/pg-pool');

const ROLE_MAP = {
  scout: ['luna_signal_runtime', 'aria', 'scout'],
  critic: ['nemesis', 'sentinel', 'guard'],
  allocator: ['hephaestos', 'risk', 'sizing'],
  learner: ['luna_evolution_controller', 'sigma_feedback_bridge'],
  publisher: ['edux', 'hermes'],
};

function roleForAgent(agentName = '') {
  const key = String(agentName).toLowerCase();
  for (const [role, aliases] of Object.entries(ROLE_MAP)) {
    if (aliases.some((alias) => key.includes(alias))) return role;
  }
  return 'operator';
}

export function registerMultiAgentMetaLearningSkill() {
  registerSkillHandler('multi-agent-meta-learning', async (params) => {
    const p = params || {};
    const rows = await pgPool.query('investment', `
      SELECT agent_name, market, invocation_count, success_count, failure_count, current_level, config, updated_at
        FROM investment.agent_curriculum_state
       ORDER BY updated_at DESC
       LIMIT $1
    `, [Math.max(1, Number(p.limit || 100))]).catch(() => []);

    const roles = {};
    for (const row of rows) {
      const role = roleForAgent(row.agent_name);
      if (!roles[role]) roles[role] = { agents: 0, invocations: 0, successes: 0, failures: 0, levels: {} };
      roles[role].agents += 1;
      roles[role].invocations += Number(row.invocation_count || 0);
      roles[role].successes += Number(row.success_count || 0);
      roles[role].failures += Number(row.failure_count || 0);
      roles[role].levels[row.current_level || 'unknown'] = (roles[role].levels[row.current_level || 'unknown'] || 0) + 1;
    }

    return {
      id: '',
      status: 'completed',
      output: {
        skill: 'multi-agent-meta-learning',
        analyzedAt: new Date().toISOString(),
        roleCount: Object.keys(roles).length,
        roles,
        recommendations: Object.entries(roles).map(([role, stats]) => ({
          role,
          action: stats.failures > stats.successes ? 'increase_observation_and_reduce_autonomy' : 'maintain_or_probe',
        })),
      },
    };
  });
}
