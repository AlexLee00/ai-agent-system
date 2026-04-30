#!/usr/bin/env tsx
'use strict';

/**
 * incident-summary.ts — 매일 자정 사고 통합 요약
 *
 * 통합 전: claude/bug-report, reservation/bug-report, alarm-noisy-producers (9개 → 1개)
 * launchd ai.hub.incident-summary.plist (매일 00:10 KST)
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pgPool = require('../../../packages/core/lib/pg-pool');
const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');
const kst = require('../../../packages/core/lib/kst');
const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env.legacy');

const AUTO_DEV_DIR = process.env.HUB_ALARM_AUTO_DEV_DIR
  || path.join(env.PROJECT_ROOT, 'docs', 'auto_dev');

interface RoundtableRow {
  id: number;
  incident_key: string;
  status: string;
  consensus: unknown;
  created_at: string;
}

interface EventRow {
  team: string;
  alarm_type: string;
  total: number;
  escalated: number;
}

async function fetchOpenRoundtables(hours: number): Promise<RoundtableRow[]> {
  try {
    return await pgPool.query('agent', `
      SELECT id, incident_key, status, consensus, created_at::text
      FROM agent.alarm_roundtables
      WHERE created_at >= NOW() - ($1 * INTERVAL '1 hour')
      ORDER BY created_at DESC
      LIMIT 20
    `, [hours]);
  } catch {
    return [];
  }
}

async function fetchAlarmStats(hours: number): Promise<EventRow[]> {
  try {
    return await pgPool.query('agent', `
      SELECT
        COALESCE(team, 'unknown') AS team,
        COALESCE(metadata->>'alarm_type', 'unknown') AS alarm_type,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE metadata->>'visibility' IN ('human_action', 'emergency'))::int AS escalated
      FROM agent.event_lake
      WHERE event_type = 'hub_alarm'
        AND created_at >= NOW() - ($1 * INTERVAL '1 hour')
      GROUP BY team, alarm_type
      ORDER BY total DESC
      LIMIT 30
    `, [hours]);
  } catch {
    return [];
  }
}

function countNewAutoDevDocs(sinceHours: number): number {
  try {
    const files = fs.readdirSync(AUTO_DEV_DIR) as string[];
    const cutoff = Date.now() - sinceHours * 60 * 60 * 1000;
    return files.filter((f: string) => {
      if (!f.endsWith('.md') || f === 'README.md') return false;
      try {
        const stat = fs.statSync(path.join(AUTO_DEV_DIR, f));
        return stat.mtimeMs >= cutoff;
      } catch {
        return false;
      }
    }).length;
  } catch {
    return 0;
  }
}

function formatIncidentSummary(
  roundtables: RoundtableRow[],
  alarmStats: EventRow[],
  newDocCount: number,
  hours: number,
): string {
  const open = roundtables.filter((r) => ['open', 'in_progress'].includes(r.status));
  const resolved = roundtables.filter((r) => r.status === 'consensus' || r.status === 'resolved');
  const totalAlarms = alarmStats.reduce((s, r) => s + r.total, 0);
  const escalated = alarmStats.reduce((s, r) => s + r.escalated, 0);
  const errorCount = alarmStats.filter((r) => r.alarm_type === 'error').reduce((s, r) => s + r.total, 0);
  const critCount = alarmStats.filter((r) => r.alarm_type === 'critical').reduce((s, r) => s + r.total, 0);

  const hasIssues = open.length > 0 || critCount > 0;
  const emoji = hasIssues ? '🟡' : '🟢';

  const lines: string[] = [
    `${emoji} [Hub] 사고 요약 (최근 ${hours}h) — ${kst.today()} KST`,
    '',
    `📊 알람 통계: 총 ${totalAlarms}건 | 오류 ${errorCount}건 | 긴급 ${critCount}건 | 에스컬레이션 ${escalated}건`,
    `🗣️ Roundtable: 진행 ${open.length}건 | 완료 ${resolved.length}건`,
    `📄 auto_dev 신규 문서: ${newDocCount}건`,
  ];

  if (open.length > 0) {
    lines.push('');
    lines.push('⏳ 미해결 Roundtable:');
    for (const r of open.slice(0, 5)) {
      lines.push(`  - [${r.status}] ${r.incident_key}`);
    }
  }

  if (alarmStats.length > 0) {
    const topTeams = [...alarmStats]
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);
    lines.push('');
    lines.push('상위 알람 팀:');
    for (const t of topTeams) {
      lines.push(`  - ${t.team} (${t.alarm_type}): ${t.total}건`);
    }
  }

  return lines.join('\n');
}

async function main() {
  const hours = 24;
  const [roundtables, alarmStats] = await Promise.allSettled([
    fetchOpenRoundtables(hours),
    fetchAlarmStats(hours),
  ]);

  const rt = roundtables.status === 'fulfilled' ? roundtables.value : [];
  const stats = alarmStats.status === 'fulfilled' ? alarmStats.value : [];
  const newDocs = countNewAutoDevDocs(hours);

  const message = formatIncidentSummary(rt, stats, newDocs, hours);
  console.log('[incident-summary]', message);

  const open = rt.filter((r) => ['open', 'in_progress'].includes(r.status));
  const hasIssues = open.length > 0;

  const sent = await postAlarm({
    team: 'hub',
    fromBot: 'incident-summary',
    alertLevel: hasIssues ? 2 : 1,
    alarmType: 'report',
    visibility: hasIssues ? 'notify' : 'digest',
    title: `사고 요약: Roundtable ${open.length}건 미해결`,
    message,
    eventType: 'incident_summary',
    incidentKey: `hub:incident_summary:${kst.today()}`,
    payload: {
      event_type: 'incident_summary',
      open_roundtables: open.length,
      total_alarms: stats.reduce((s, r) => s + r.total, 0),
      new_auto_dev_docs: newDocs,
      hours,
    },
  });

  if (!sent?.ok) {
    console.error('[incident-summary] 알람 발송 실패:', sent?.error);
    process.exit(1);
  }
  console.log('[incident-summary] 완료');
}

main().catch((err: Error) => {
  console.error('[incident-summary] 실패:', err.message);
  process.exit(1);
});
