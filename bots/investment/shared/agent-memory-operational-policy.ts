// @ts-nocheck
/**
 * shared/agent-memory-operational-policy.ts
 *
 * Luna Agent Memory / LLM Routing 운영 단계 판단과 route 품질 분석.
 * 실제 설정 변경은 하지 않고, operator가 안전하게 제안/보고만 할 수 있도록
 * 결정 로직을 한곳에 모은다.
 */

import * as db from './db.ts';
import { resolveAgentMemoryRuntimeFlags } from './agent-memory-runtime.ts';

const ACTIVATION_STEPS = [
  {
    phase: 'memory_prefix_shadow',
    description: 'Persona/Constitution + memory prefix를 shadow로 활성화',
    envPatch: {
      LUNA_AGENT_LEARNING_MODE: 'shadow',
      LUNA_AGENT_MEMORY_AUTO_PREFIX: 'true',
      LUNA_AGENT_PERSONA_ENABLED: 'true',
      LUNA_AGENT_CONSTITUTION_ENABLED: 'true',
      LUNA_AGENT_MEMORY_LAYER_1: 'true',
    },
  },
  {
    phase: 'llm_routing_shadow',
    description: 'Agent x market x task LLM route chain을 shadow 관측',
    envPatch: {
      LUNA_AGENT_LLM_ROUTING_ENABLED: 'true',
    },
  },
  {
    phase: 'reflexion_guard_shadow',
    description: '실패 패턴 기반 provider/prompt 회피를 shadow에서 관측',
    envPatch: {
      LUNA_AGENT_REFLEXION_AUTO_AVOID_ENABLED: 'true',
    },
  },
  {
    phase: 'cross_bus_shadow',
    description: '에이전트 간 질의/응답 버스를 shadow에서 활성화',
    envPatch: {
      LUNA_AGENT_CROSS_BUS_ENABLED: 'true',
    },
  },
  {
    phase: 'curriculum_shadow',
    description: '에이전트별 성공률 기반 curriculum 조정을 활성화',
    envPatch: {
      LUNA_AGENT_CURRICULUM_ENABLED: 'true',
    },
  },
  {
    phase: 'autonomous_l5_ready',
    description: 'Agent memory/routing L5 운영 준비 완료',
    envPatch: {
      LUNA_AGENT_LEARNING_MODE: 'autonomous_l5',
    },
  },
];

function isEnvPatchSatisfied(flags, envPatch) {
  const mode = String(flags.mode || 'off').toLowerCase();
  for (const [key, value] of Object.entries(envPatch || {})) {
    const expected = String(value).toLowerCase();
    if (key === 'LUNA_AGENT_LEARNING_MODE') {
      if (expected === 'shadow' && !['shadow', 'supervised_l4', 'autonomous_l5'].includes(mode)) return false;
      if (expected === 'autonomous_l5' && mode !== 'autonomous_l5') return false;
      continue;
    }
    const flagName = {
      LUNA_AGENT_MEMORY_AUTO_PREFIX: 'memoryAutoPrefix',
      LUNA_AGENT_PERSONA_ENABLED: 'personaEnabled',
      LUNA_AGENT_CONSTITUTION_ENABLED: 'constitutionEnabled',
      LUNA_AGENT_MEMORY_LAYER_1: 'layer1WorkingMemoryEnabled',
      LUNA_AGENT_LLM_ROUTING_ENABLED: 'llmRoutingEnabled',
      LUNA_AGENT_REFLEXION_AUTO_AVOID_ENABLED: 'reflexionAutoAvoidEnabled',
      LUNA_AGENT_CROSS_BUS_ENABLED: 'crossBusEnabled',
      LUNA_AGENT_CURRICULUM_ENABLED: 'curriculumEnabled',
    }[key];
    if (!flagName) continue;
    if ((flags[flagName] === true) !== (expected === 'true')) return false;
  }
  return true;
}

export function buildAgentMemoryActivationPlan(flags = resolveAgentMemoryRuntimeFlags()) {
  const steps = ACTIVATION_STEPS.map((step) => ({
    ...step,
    satisfied: isEnvPatchSatisfied(flags, step.envPatch),
  }));
  const next = steps.find((step) => !step.satisfied) || null;
  const blockers = [];
  if (flags.llmRoutingEnabled && !flags.memoryAutoPrefix) {
    blockers.push('llm_routing_enabled_without_memory_prefix');
  }
  if (flags.crossBusEnabled && String(flags.mode || 'off') === 'off') {
    blockers.push('cross_bus_enabled_while_learning_mode_off');
  }
  return {
    ok: blockers.length === 0,
    mode: flags.mode,
    currentSatisfied: steps.filter((step) => step.satisfied).map((step) => step.phase),
    nextPhase: next?.phase || null,
    nextDescription: next?.description || null,
    recommendedEnvPatch: next?.envPatch || {},
    steps,
    blockers,
  };
}

export async function buildAgentLlmRouteQualityReport({
  days = 3,
  market = 'all',
  minCalls = 3,
  failThreshold = 0.25,
  fallbackThreshold = 0.35,
} = {}) {
  await db.initSchema();
  const windowDays = Math.max(1, Number(days || 3) || 3);
  const normalizedMarket = String(market || 'all').trim().toLowerCase() || 'all';
  const minCallCount = Math.max(1, Number(minCalls || 3) || 3);
  const rows = await db.query(
    `SELECT
       agent_name,
       COALESCE(market, 'any') AS market,
       COALESCE(task_type, 'default') AS task_type,
       COALESCE(provider, 'unknown') AS provider,
       COUNT(*) AS calls,
       SUM(CASE WHEN response_ok IS FALSE THEN 1 ELSE 0 END) AS failed_calls,
       SUM(CASE WHEN fallback_used THEN 1 ELSE 0 END) AS fallback_calls,
       AVG(latency_ms) AS avg_latency_ms,
       MAX(created_at) AS last_seen_at
     FROM investment.llm_routing_log
     WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
       AND ($2::text = 'all' OR market = $2 OR market IS NULL)
     GROUP BY agent_name, market, task_type, provider
     ORDER BY calls DESC, failed_calls DESC, fallback_calls DESC
     LIMIT 200`,
    [windowDays, normalizedMarket],
  ).catch(() => []);

  const providerRows = await db.query(
    `SELECT
       COALESCE(provider, 'unknown') AS provider,
       COUNT(*) AS calls,
       SUM(CASE WHEN response_ok IS FALSE THEN 1 ELSE 0 END) AS failed_calls,
       SUM(CASE WHEN fallback_used THEN 1 ELSE 0 END) AS fallback_calls,
       AVG(latency_ms) AS avg_latency_ms,
       MAX(created_at) AS last_seen_at
     FROM investment.llm_routing_log
     WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
       AND ($2::text = 'all' OR market = $2 OR market IS NULL)
     GROUP BY provider
     ORDER BY calls DESC, failed_calls DESC, fallback_calls DESC
     LIMIT 100`,
    [windowDays, normalizedMarket],
  ).catch(() => []);

  const suggestions = [];
  for (const row of rows) {
    const calls = Number(row.calls || 0);
    if (calls < minCallCount) continue;
    const failed = Number(row.failed_calls || 0);
    const fallback = Number(row.fallback_calls || 0);
    const failureRate = calls > 0 ? failed / calls : 0;
    const fallbackRate = calls > 0 ? fallback / calls : 0;
    if (String(row.provider || '') === 'direct_fallback' && fallbackRate >= fallbackThreshold) {
      suggestions.push({
        type: 'direct_fallback_usage',
        severity: 'medium',
        agent: row.agent_name,
        market: row.market,
        taskType: row.task_type,
        provider: row.provider,
        calls,
        failureRate,
        fallbackRate,
        recommendation: '직접 fallback 사용이 반복됩니다. Hub route 활성화/인증/selector 연결 상태를 점검하세요.',
      });
      continue;
    }
    if (failureRate >= failThreshold) {
      suggestions.push({
        type: 'route_failure_review',
        severity: failureRate >= 0.5 ? 'high' : 'medium',
        agent: row.agent_name,
        market: row.market,
        taskType: row.task_type,
        provider: row.provider,
        calls,
        failureRate,
        fallbackRate,
        recommendation: '해당 agent/task provider를 cooldown/reset 점검하거나 fallback 우선순위를 높이세요.',
      });
    } else if (fallbackRate >= fallbackThreshold) {
      suggestions.push({
        type: 'route_fallback_pressure',
        severity: fallbackRate >= 0.6 ? 'high' : 'medium',
        agent: row.agent_name,
        market: row.market,
        taskType: row.task_type,
        provider: row.provider,
        calls,
        failureRate,
        fallbackRate,
        recommendation: 'primary route latency/쿼터/응답 품질을 점검하고 fallback 체인 재정렬 후보로 올리세요.',
      });
    }
  }

  return {
    ok: suggestions.every((item) => item.severity !== 'high'),
    status: suggestions.length ? 'route_quality_attention' : 'route_quality_clear',
    generatedAt: new Date().toISOString(),
    days: windowDays,
    market: normalizedMarket,
    thresholds: {
      minCalls: minCallCount,
      failThreshold,
      fallbackThreshold,
    },
    rows,
    providers: providerRows,
    suggestions,
  };
}

export default {
  buildAgentMemoryActivationPlan,
  buildAgentLlmRouteQualityReport,
};
