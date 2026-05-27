// @ts-nocheck
/**
 * bots/sigma/a2a/skills/guard-tuning-meta-learning.ts
 *
 * 시그마 메타 학습: 루나 가드 패턴 분석 + 조정 제안
 *
 * 시그마 역할: 모든 팀의 메타 최적화 + 시스템 일관성 검증
 * 이 스킬은 루나 가드 데이터를 분석하여 시그마 feedback_effectiveness에 반영한다.
 */

import { registerSkillHandler } from '../handlers/task-handler.ts';

const HUB_URL = process.env.HUB_URL || 'http://localhost:7788';
const HUB_TOKEN = process.env.HUB_AUTH_TOKEN;

async function hubQuery(sql) {
  if (!HUB_TOKEN) return [];
  const res = await fetch(`${HUB_URL}/hub/pg/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${HUB_TOKEN}`,
    },
    body: JSON.stringify({ sql }),
  }).catch(() => null);
  if (!res?.ok) return [];
  const data = await res.json().catch(() => null);
  return data?.rows || [];
}

async function fetchGuardStats(days = 30) {
  return hubQuery(`
    SELECT
      guard_name,
      COUNT(*)                                        AS total_triggers,
      COUNT(*) FILTER (WHERE outcome = 'success')    AS false_positives,
      COUNT(*) FILTER (WHERE outcome = 'failure')    AS true_positives,
      COUNT(*) FILTER (WHERE outcome IS NULL)        AS pending,
      ROUND(
        100.0 * COUNT(*) FILTER (WHERE outcome = 'success')
        / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0),
        1
      )                                              AS fp_rate_pct,
      MAX(triggered_at)                              AS last_triggered
    FROM investment.guard_events
    WHERE triggered_at >= NOW() - INTERVAL '${days} days'
    GROUP BY guard_name
    ORDER BY COUNT(*) DESC
    LIMIT 20
  `);
}

async function fetchSelfTuningLog(days = 7) {
  return hubQuery(`
    SELECT
      guard_name,
      recommendation,
      false_positive_rate,
      llm_reasoning,
      shadow_mode,
      master_approved,
      created_at
    FROM investment.guard_self_tuning_log
    WHERE created_at >= NOW() - INTERVAL '${days} days'
    ORDER BY created_at DESC
    LIMIT 20
  `);
}

function buildMetaAnalysis(guardStats, tuningLog) {
  const highFpGuards = guardStats.filter(
    (r) => Number(r.fp_rate_pct || 0) > 30,
  );
  const lowFpGuards = guardStats.filter(
    (r) => Number(r.fp_rate_pct || 0) < 5 && Number(r.total_triggers || 0) >= 10,
  );
  const pendingApprovals = tuningLog.filter(
    (r) => r.shadow_mode === true && r.master_approved === false,
  );

  const systemHealth = highFpGuards.length === 0 && pendingApprovals.length < 3
    ? 'healthy'
    : highFpGuards.length > 2 || pendingApprovals.length >= 3
      ? 'attention'
      : 'monitor';

  const insights = [];
  if (highFpGuards.length > 0) {
    insights.push({
      type: 'over_sensitive_guards',
      count: highFpGuards.length,
      guards: highFpGuards.map((r) => r.guard_name),
      recommendation: 'False positive 비율이 높은 가드의 임계값 완화를 권장합니다.',
    });
  }
  if (lowFpGuards.length > 0) {
    insights.push({
      type: 'under_sensitive_guards',
      count: lowFpGuards.length,
      guards: lowFpGuards.map((r) => r.guard_name),
      recommendation: '항상 맞는 가드는 임계값 강화로 더 많은 위험을 차단할 수 있습니다.',
    });
  }
  if (pendingApprovals.length > 0) {
    insights.push({
      type: 'pending_master_approval',
      count: pendingApprovals.length,
      guards: pendingApprovals.map((r) => r.guard_name),
      recommendation: `마스터 승인 대기 중인 가드 조정이 ${pendingApprovals.length}개 있습니다.`,
    });
  }

  return {
    systemHealth,
    totalGuardsAnalyzed: guardStats.length,
    highFpGuardCount: highFpGuards.length,
    lowFpGuardCount: lowFpGuards.length,
    pendingApprovalCount: pendingApprovals.length,
    insights,
    dataQuality: {
      guardStatsRows: guardStats.length,
      tuningLogRows: tuningLog.length,
    },
  };
}

export function registerGuardTuningMetaLearningSkill() {
  registerSkillHandler(
    'guard-tuning-meta-learning',
    async (params) => {
      const p = params || {};
      const days = Number(p.days || 30);
      const includeDetails = p.includeDetails === true;

      const [guardStats, tuningLog] = await Promise.all([
        fetchGuardStats(days),
        fetchSelfTuningLog(7),
      ]);

      const analysis = buildMetaAnalysis(guardStats, tuningLog);

      const output = {
        skill: 'guard-tuning-meta-learning',
        analyzedAt: new Date().toISOString(),
        period: `${days}d`,
        ...analysis,
      };

      if (includeDetails) {
        output.guardStats = guardStats;
        output.tuningLog = tuningLog;
      }

      return {
        id: '',
        status: 'completed',
        output,
      };
    },
  );
}
