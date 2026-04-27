#!/usr/bin/env tsx
'use strict';

const { buildAlarmNoiseReport } = require('./alarm-noise-report.ts');
const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');
const { upsertAlarmSuppressionRules } = require('../lib/alarm/suppression-rules.ts');

function argValue(name: string, fallback = ''): string {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function normalizeNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function buildProposal(row: Record<string, any>, minTotal: number) {
  const total = Number(row.total || 0);
  const escalated = Number(row.escalated || 0);
  if (total < minTotal) return null;
  const clusterKey = String(row.cluster_key || '').trim();
  const alarmType = String(row.alarm_type || '').trim().toLowerCase();
  const team = String(row.team || 'unknown').trim().toLowerCase();
  const producer = String(row.producer || 'unknown').trim();
  if (!team || !producer) return null;

  const action = escalated > 0
    ? 'tighten_incident_key'
    : alarmType === 'report'
      ? 'reduce_repeat_interval'
      : 'route_to_digest';

  return {
    team,
    producer,
    alarm_type: alarmType || 'unknown',
    cluster_key: clusterKey || null,
    total,
    escalated,
    action,
    dry_run_rule: {
      team,
      fromBot: producer,
      visibility: action === 'route_to_digest' ? 'digest' : null,
      incidentKeyPrefix: clusterKey ? clusterKey.split('|').slice(0, 2).join('|') : null,
    },
    rationale: escalated > 0
      ? 'Escalated noise exists; first normalize incident keys before suppressing.'
      : 'High-volume non-escalated alarm; route to digest or suppress duplicates after review.',
  };
}

function formatProposals(proposals: Array<Record<string, any>>, minutes: number): string {
  const lines = [
    '🧹 [hub] 알람 suppress 제안',
    `기간: 최근 ${minutes}분`,
    `제안: ${proposals.length}건`,
  ];
  if (proposals.length === 0) {
    lines.push('상태: 적용 후보 없음');
    return lines.join('\n');
  }
  lines.push('');
  for (const proposal of proposals.slice(0, 8)) {
    lines.push(`- ${proposal.team}/${proposal.producer}: ${proposal.action} total=${proposal.total} escalated=${proposal.escalated}`);
    if (proposal.cluster_key) lines.push(`  cluster=${proposal.cluster_key}`);
  }
  lines.push('');
  lines.push('주의: --apply 없이 실행하면 정책을 변경하지 않습니다.');
  return lines.join('\n');
}

export async function buildAlarmSuppressionProposals({
  minutes = 24 * 60,
  limit = 20,
  minTotal = 5,
  db,
}: {
  minutes?: number;
  limit?: number;
  minTotal?: number;
  db?: { query: (...args: any[]) => Promise<Array<Record<string, any>>> };
} = {}) {
  const report = await buildAlarmNoiseReport({ minutes, limit, db });
  const threshold = normalizeNumber(minTotal, 5, 2, 10_000);
  const proposals = report.rows
    .map((row: Record<string, any>) => buildProposal(row, threshold))
    .filter(Boolean);
  return {
    ok: true,
    minutes: report.minutes,
    limit: report.limit,
    min_total: threshold,
    proposals,
    message: formatProposals(proposals, report.minutes),
  };
}

export async function applyAlarmSuppressionProposals({
  minutes = 24 * 60,
  limit = 20,
  minTotal = 5,
  db,
  rulesPath,
}: {
  minutes?: number;
  limit?: number;
  minTotal?: number;
  db?: { query: (...args: any[]) => Promise<Array<Record<string, any>>> };
  rulesPath?: string;
} = {}) {
  const proposals = await buildAlarmSuppressionProposals({ minutes, limit, minTotal, db });
  const applyResult = upsertAlarmSuppressionRules(proposals.proposals as Array<Record<string, any>>, {
    rulesPath,
  });
  return {
    ...proposals,
    applied: true,
    apply_result: applyResult,
  };
}

async function main() {
  const minutes = normalizeNumber(argValue('minutes', ''), 24 * 60, 1, 7 * 24 * 60);
  const limit = normalizeNumber(argValue('limit', ''), 20, 1, 100);
  const minTotal = normalizeNumber(argValue('min-total', ''), 5, 2, 10_000);
  const result = await buildAlarmSuppressionProposals({ minutes, limit, minTotal });
  const finalResult = hasFlag('apply')
    ? await applyAlarmSuppressionProposals({ minutes, limit, minTotal })
    : result;
  if (hasFlag('json')) console.log(JSON.stringify(finalResult, null, 2));
  else {
    console.log(finalResult.message);
    if ((finalResult as any).applied) {
      console.log(`applied=${(finalResult as any).apply_result?.applied_count || 0} skipped=${(finalResult as any).apply_result?.skipped_count || 0}`);
    }
  }
  if (hasFlag('send')) {
    const sent = await postAlarm({
      message: (finalResult as any).applied
        ? `${finalResult.message}\n\n적용: ${(finalResult as any).apply_result?.applied_count || 0}건 / 보류: ${(finalResult as any).apply_result?.skipped_count || 0}건`
        : finalResult.message,
      team: 'hub',
      fromBot: 'alarm-suppression-proposals',
      alertLevel: 1,
      alarmType: 'report',
      visibility: 'notify',
      incidentKey: `hub:alarm_suppression_proposals:${new Date().toISOString().slice(0, 10)}`,
      eventType: 'alarm_suppression_proposals',
      payload: {
        event_type: 'alarm_suppression_proposals',
        proposal_count: finalResult.proposals.length,
        applied: Boolean((finalResult as any).applied),
      },
    });
    if (!sent?.ok) throw new Error(sent?.error || 'alarm_suppression_proposals_send_failed');
  }
}

if (require.main === module) {
  main().catch((error: any) => {
    console.error('[alarm-suppression-proposals] failed:', error?.message || error);
    process.exit(1);
  });
}

module.exports = {
  applyAlarmSuppressionProposals,
  buildAlarmSuppressionProposals,
};
