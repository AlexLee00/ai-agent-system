#!/usr/bin/env tsx
'use strict';

/**
 * alarm-roundtable-reflection.ts — 매월 Roundtable 회고
 *
 * 매월 1일 09:00 실행 (launchd ai.hub.roundtable-reflection)
 *
 * 분석 내용:
 *   - 지난 30일 roundtable 건수 및 상태 분포
 *   - 가장 빈번한 incident 팀/유형
 *   - 합의 도출률 및 평균 합의 점수
 *   - 구현 완료(resolved)율
 *   - 시스템 개선 제안
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pgPool = require('../../../packages/core/lib/pg-pool');
const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');
const kst = require('../../../packages/core/lib/kst');

const REFLECTION_WINDOW_DAYS = Number(process.env.HUB_ROUNDTABLE_REFLECTION_WINDOW_DAYS || 30) || 30;

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const DRY_RUN = hasFlag('dry-run') || ['1', 'true', 'yes', 'y', 'on'].includes(
  String(process.env.HUB_ROUNDTABLE_REFLECTION_DRY_RUN || '').trim().toLowerCase(),
);
const JSON_OUTPUT = hasFlag('json');
const FIXTURE_MODE = hasFlag('fixture') || ['1', 'true', 'yes', 'y', 'on'].includes(
  String(process.env.HUB_ROUNDTABLE_REFLECTION_FIXTURE || '').trim().toLowerCase(),
);

function isEnabled(): boolean {
  const raw = String(process.env.HUB_ROUNDTABLE_REFLECTION_ENABLED || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw);
}

// ────── DB 조회 ──────

interface RoundtableStats {
  total: number;
  by_status: Record<string, number>;
  consensus_count: number;
  avg_agreement_score: number;
  top_teams: Array<{ team: string; count: number }>;
  resolved_count: number;
  open_count: number;
}

async function fetchRoundtableStats(): Promise<RoundtableStats | null> {
  try {
    // 전체 건수 + 상태별 분포
    const statusRows = await pgPool.query('agent', `
      SELECT status, COUNT(*)::int AS count
      FROM agent.alarm_roundtables
      WHERE created_at >= NOW() - ($1 * INTERVAL '1 day')
      GROUP BY status
      ORDER BY count DESC
    `, [REFLECTION_WINDOW_DAYS]);

    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const row of (statusRows || [])) {
      byStatus[row.status] = Number(row.count);
      total += Number(row.count);
    }

    // 합의 통계
    const consensusRow = await pgPool.get('agent', `
      SELECT
        COUNT(*)::int AS consensus_count,
        ROUND(AVG((consensus->>'agreementScore')::numeric), 2) AS avg_score
      FROM agent.alarm_roundtables
      WHERE created_at >= NOW() - ($1 * INTERVAL '1 day')
        AND status = 'consensus'
        AND consensus IS NOT NULL
    `, [REFLECTION_WINDOW_DAYS]);

    // 팀별 빈도 (incident_key 파싱)
    const teamRows = await pgPool.query('agent', `
      SELECT
        SPLIT_PART(incident_key, ':', 2) AS team,
        COUNT(*)::int AS count
      FROM agent.alarm_roundtables
      WHERE created_at >= NOW() - ($1 * INTERVAL '1 day')
        AND incident_key LIKE '%:%'
      GROUP BY 1
      ORDER BY count DESC
      LIMIT 5
    `, [REFLECTION_WINDOW_DAYS]);

    return {
      total,
      by_status: byStatus,
      consensus_count: Number(consensusRow?.consensus_count || 0),
      avg_agreement_score: Number(consensusRow?.avg_score || 0),
      top_teams: (teamRows || []).map((r: Record<string, unknown>) => ({
        team: String(r.team || 'unknown'),
        count: Number(r.count),
      })),
      resolved_count: Number(byStatus['resolved'] || 0),
      open_count: Number(byStatus['open'] || 0) + Number(byStatus['in_progress'] || 0),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[roundtable-reflection] DB 조회 실패: ${msg}`);
    return null;
  }
}

// ────── 개선 제안 생성 ──────

function generateInsights(stats: RoundtableStats): string[] {
  const insights: string[] = [];

  const resolvedRate = stats.total > 0 ? (stats.resolved_count / stats.total) * 100 : 0;
  const consensusRate = stats.total > 0 ? (stats.consensus_count / stats.total) * 100 : 0;

  if (resolvedRate < 60) {
    insights.push(`⚠️ 해소율 ${resolvedRate.toFixed(0)}% — auto-dev-watch 처리 파이프라인 점검 필요`);
  } else {
    insights.push(`✅ 해소율 ${resolvedRate.toFixed(0)}% — 폐쇄 사이클 정상 작동`);
  }

  if (consensusRate < 70) {
    insights.push(`⚠️ 합의 도출률 ${consensusRate.toFixed(0)}% — LLM 프롬프트 튜닝 또는 임계치 조정 고려`);
  } else {
    insights.push(`✅ 합의 도출률 ${consensusRate.toFixed(0)}% — Roundtable 품질 양호`);
  }

  if (stats.avg_agreement_score < 0.65) {
    insights.push(`📊 평균 합의 점수 ${(stats.avg_agreement_score * 100).toFixed(0)}% — 참여자 다양성 또는 프롬프트 구조 개선 검토`);
  }

  if (stats.open_count > stats.resolved_count) {
    insights.push(`🔴 미해소 ${stats.open_count}건 > 해소 ${stats.resolved_count}건 — 처리 병목 확인 필요`);
  }

  if (stats.top_teams.length > 0 && stats.top_teams[0].count > stats.total * 0.5) {
    insights.push(`📌 ${stats.top_teams[0].team}팀이 전체 ${stats.total}건 중 ${stats.top_teams[0].count}건 (${((stats.top_teams[0].count / stats.total) * 100).toFixed(0)}%) — 해당 팀 집중 점검 권장`);
  }

  if (insights.length === 0) {
    insights.push('✅ 전반적으로 양호한 운영 상태');
  }

  return insights;
}

// ────── 메시지 빌드 ──────

function buildReflectionMessage(stats: RoundtableStats | null, today: string): string {
  if (!stats || stats.total === 0) {
    return [
      `📊 [Monthly Roundtable Reflection] ${today}`,
      `기간: 지난 ${REFLECTION_WINDOW_DAYS}일`,
      '',
      '✅ 이번 달 Roundtable 없음 — 알람 품질 양호 또는 임계치 미달',
    ].join('\n');
  }

  const resolvedRate = stats.total > 0 ? ((stats.resolved_count / stats.total) * 100).toFixed(0) : '0';
  const consensusRate = stats.total > 0 ? ((stats.consensus_count / stats.total) * 100).toFixed(0) : '0';
  const insights = generateInsights(stats);

  const lines: string[] = [
    `📊 [Monthly Roundtable Reflection] ${today}`,
    `기간: 지난 ${REFLECTION_WINDOW_DAYS}일`,
    '',
    `📈 통계:`,
    `  총 Roundtable: ${stats.total}건`,
    `  합의 도출: ${stats.consensus_count}건 (${consensusRate}%)`,
    `  해소 완료: ${stats.resolved_count}건 (${resolvedRate}%)`,
    `  미해소: ${stats.open_count}건`,
    `  평균 합의 점수: ${(stats.avg_agreement_score * 100).toFixed(0)}%`,
  ];

  if (stats.top_teams.length > 0) {
    lines.push('');
    lines.push('🏆 빈발 팀:');
    for (const t of stats.top_teams.slice(0, 3)) {
      lines.push(`  ${t.team}: ${t.count}건`);
    }
  }

  if (Object.keys(stats.by_status).length > 0) {
    lines.push('');
    lines.push('📊 상태 분포:');
    for (const [status, count] of Object.entries(stats.by_status)) {
      lines.push(`  ${status}: ${count}건`);
    }
  }

  lines.push('');
  lines.push('💡 시스템 개선 제안:');
  for (const insight of insights) {
    lines.push(`  ${insight}`);
  }

  return lines.join('\n');
}

// ────── 메인 ──────

async function main() {
  console.log('[roundtable-reflection] 매월 Roundtable 회고 시작');

  if (!isEnabled()) {
    console.log('[roundtable-reflection] HUB_ROUNDTABLE_REFLECTION_ENABLED 비활성화 — 종료');
    process.exit(0);
  }

  const today = kst.today ? kst.today() : new Date().toISOString().slice(0, 10);

  const stats = FIXTURE_MODE ? {
    total: 8,
    by_status: { resolved: 5, consensus: 2, open: 1 },
    consensus_count: 7,
    avg_agreement_score: 0.82,
    top_teams: [{ team: 'luna', count: 5 }, { team: 'hub', count: 3 }],
    resolved_count: 5,
    open_count: 1,
  } : await fetchRoundtableStats();
  const message = buildReflectionMessage(stats, today);

  console.log('[roundtable-reflection]', message);

  const payload = {
    ok: true,
    dry_run: DRY_RUN,
    fixture: FIXTURE_MODE,
    window_days: REFLECTION_WINDOW_DAYS,
    stats: stats || {},
    message,
  };

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(payload, null, 2));
  }

  if (DRY_RUN) {
    console.log('[roundtable-reflection] dry-run — Telegram 발송 스킵');
    return;
  }

  const sent = await postAlarm({
    team: 'hub',
    fromBot: 'roundtable-reflection',
    alertLevel: stats && stats.open_count > stats.resolved_count ? 2 : 1,
    alarmType: 'report',
    visibility: 'notify',
    title: `[Monthly Reflection] Roundtable ${stats?.total || 0}건 회고`,
    message,
    eventType: 'roundtable_monthly_reflection',
    incidentKey: `hub:roundtable_reflection:${today.slice(0, 7)}`, // YYYY-MM
    payload: {
      event_type: 'roundtable_monthly_reflection',
      window_days: REFLECTION_WINDOW_DAYS,
      stats: stats || {},
    },
  });

  if (!sent?.ok) {
    console.error('[roundtable-reflection] 알람 발송 실패:', sent?.error);
    process.exit(1);
  }

  console.log('[roundtable-reflection] 완료');
}

main().catch((err: Error) => {
  console.error('[roundtable-reflection] 치명적 오류:', err.message);
  process.exit(1);
});
