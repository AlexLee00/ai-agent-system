#!/usr/bin/env tsx
'use strict';

/**
 * weekly-advisory-digest.ts — 매주 일요일 09:00 KST 제안/권고 통합
 *
 * 통합 전: autotune 7종, remodel-blockers, posttrade-feedback 등 10개 → 1개
 * launchd ai.hub.weekly-advisory-digest.plist (매주 일요일 09:00 KST)
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pgPool = require('../../../packages/core/lib/pg-pool');
const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');
const kst = require('../../../packages/core/lib/kst');

interface AutotuneRow {
  experiment_type: string;
  total: number;
  promoted: number;
  rejected: number;
}

interface PosttradeRow {
  feedback_type: string;
  count: number;
  avg_score: number;
}

interface RemodelRow {
  blocker_type: string;
  count: number;
}

async function fetchAutotuneStats(): Promise<AutotuneRow[]> {
  try {
    return await pgPool.query('agent', `
      SELECT
        COALESCE(metadata->>'experiment_type', metadata->>'autotune_type', 'general') AS experiment_type,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE metadata->>'result' = 'promoted')::int AS promoted,
        COUNT(*) FILTER (WHERE metadata->>'result' = 'rejected')::int AS rejected
      FROM agent.event_lake
      WHERE event_type IN ('autotune_experiment', 'autotune_promotion', 'autotune_review')
        AND created_at >= NOW() - INTERVAL '7 days'
      GROUP BY experiment_type
      ORDER BY total DESC
    `, []);
  } catch {
    return [];
  }
}

async function fetchPosttradeFeedback(): Promise<PosttradeRow[]> {
  try {
    return await pgPool.query('agent', `
      SELECT
        COALESCE(metadata->>'feedback_type', 'general') AS feedback_type,
        COUNT(*)::int AS count,
        ROUND(AVG((metadata->>'score')::numeric), 2)::float AS avg_score
      FROM agent.event_lake
      WHERE event_type IN ('posttrade_feedback', 'runtime_strategy_feedback', 'strategy_remediation')
        AND created_at >= NOW() - INTERVAL '7 days'
      GROUP BY feedback_type
      ORDER BY count DESC
      LIMIT 10
    `, []);
  } catch {
    return [];
  }
}

async function fetchRemodelBlockers(): Promise<RemodelRow[]> {
  try {
    return await pgPool.query('agent', `
      SELECT
        COALESCE(metadata->>'blocker_type', 'unknown') AS blocker_type,
        COUNT(*)::int AS count
      FROM agent.event_lake
      WHERE event_type IN ('remodel_blocker', 'remodel_closeout')
        AND created_at >= NOW() - INTERVAL '7 days'
      GROUP BY blocker_type
      ORDER BY count DESC
      LIMIT 5
    `, []);
  } catch {
    return [];
  }
}

async function fetchSuppressionProposals(): Promise<number> {
  try {
    const row = await pgPool.get('agent', `
      SELECT COUNT(*)::int AS cnt
      FROM agent.event_lake
      WHERE event_type = 'suppression_proposal'
        AND metadata->>'applied' IS NULL
        AND created_at >= NOW() - INTERVAL '7 days'
    `, []);
    return Number(row?.cnt || 0);
  } catch {
    return 0;
  }
}

function formatAdvisoryDigest(
  autotune: AutotuneRow[],
  posttrade: PosttradeRow[],
  remodel: RemodelRow[],
  suppressionCount: number,
): string {
  const totalExperiments = autotune.reduce((s, r) => s + r.total, 0);
  const totalPromoted = autotune.reduce((s, r) => s + r.promoted, 0);
  const hasAdvisory = totalExperiments > 0 || suppressionCount > 0 || remodel.length > 0;
  const emoji = hasAdvisory ? '💡' : '💡✅';

  const lines: string[] = [
    `${emoji} [Hub] 주간 권고 리포트 — ${kst.today()} KST`,
    '',
  ];

  if (autotune.length > 0) {
    lines.push(`🔬 Autotune 7일: 총 ${totalExperiments}개 실험 | 채택 ${totalPromoted}개`);
    for (const a of autotune.slice(0, 5)) {
      lines.push(`  - ${a.experiment_type}: 실험 ${a.total}회 | 채택 ${a.promoted} | 거부 ${a.rejected}`);
    }
    lines.push('');
  }

  if (posttrade.length > 0) {
    lines.push('📈 전략 피드백:');
    for (const p of posttrade.slice(0, 5)) {
      const scoreStr = p.avg_score ? ` (avg score: ${p.avg_score.toFixed(2)})` : '';
      lines.push(`  - ${p.feedback_type}: ${p.count}건${scoreStr}`);
    }
    lines.push('');
  }

  if (remodel.length > 0) {
    lines.push('🔧 리모델 블로커:');
    for (const r of remodel) {
      lines.push(`  - ${r.blocker_type}: ${r.count}건`);
    }
    lines.push('');
  }

  if (suppressionCount > 0) {
    lines.push(`⚙️ 미적용 Suppression 제안: ${suppressionCount}건 → /hub/alarm/suppression/proposals 검토 필요`);
  }

  return lines.join('\n');
}

async function main() {
  const [autotuneStats, posttradeData, remodelData, suppCount] = await Promise.allSettled([
    fetchAutotuneStats(),
    fetchPosttradeFeedback(),
    fetchRemodelBlockers(),
    fetchSuppressionProposals(),
  ]);

  const autotune = autotuneStats.status === 'fulfilled' ? autotuneStats.value : [];
  const posttrade = posttradeData.status === 'fulfilled' ? posttradeData.value : [];
  const remodel = remodelData.status === 'fulfilled' ? remodelData.value : [];
  const suppressions = suppCount.status === 'fulfilled' ? suppCount.value : 0;

  const message = formatAdvisoryDigest(autotune, posttrade, remodel, suppressions);
  console.log('[weekly-advisory-digest]', message);

  const needsApproval = suppressions > 0;

  const sent = await postAlarm({
    team: 'hub',
    fromBot: 'weekly-advisory-digest',
    alertLevel: needsApproval ? 2 : 1,
    alarmType: 'report',
    visibility: needsApproval ? 'needs_approval' as any : 'digest',
    actionability: needsApproval ? 'needs_approval' : 'none',
    title: `주간 권고: Autotune ${autotune.reduce((s, r) => s + r.total, 0)}개 실험`,
    message,
    eventType: 'weekly_advisory_digest',
    incidentKey: `hub:weekly_advisory:${kst.today()}`,
    payload: {
      event_type: 'weekly_advisory_digest',
      autotune_total: autotune.reduce((s, r) => s + r.total, 0),
      autotune_promoted: autotune.reduce((s, r) => s + r.promoted, 0),
      suppression_proposals_pending: suppressions,
      needs_approval: needsApproval,
    },
  });

  if (!sent?.ok) {
    console.error('[weekly-advisory-digest] 알람 발송 실패:', sent?.error);
    process.exit(1);
  }
  console.log('[weekly-advisory-digest] 완료');
}

main().catch((err: Error) => {
  console.error('[weekly-advisory-digest] 실패:', err.message);
  process.exit(1);
});
