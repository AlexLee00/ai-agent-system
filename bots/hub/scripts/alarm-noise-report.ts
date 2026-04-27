#!/usr/bin/env tsx
'use strict';

const pgPool = require('../../../packages/core/lib/pg-pool');
const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');

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

function formatNoiseReport(rows: Array<Record<string, any>>, minutes: number): string {
  const lines = [
    '📊 [hub] 알람 다이어트 리포트',
    `기간: 최근 ${minutes}분`,
    `대상: ${rows.length}개 producer/cluster`,
  ];
  if (rows.length === 0) {
    lines.push('상태: 조치 후보 없음');
    return lines.join('\n');
  }
  lines.push('');
  lines.push('상위 noisy producer:');
  for (const row of rows.slice(0, 8)) {
    lines.push(
      `- ${row.team}/${row.producer}: ${row.total}건, escalated ${row.escalated}, cluster=${row.cluster_key || 'none'}`,
    );
  }
  lines.push('');
  lines.push('권장: total이 높고 escalated가 낮은 항목은 digest/suppress 또는 incident_key 정규화 후보입니다.');
  return lines.join('\n');
}

export async function buildAlarmNoiseReport({
  minutes = 24 * 60,
  limit = 20,
  db = pgPool,
}: {
  minutes?: number;
  limit?: number;
  db?: { query: (...args: any[]) => Promise<Array<Record<string, any>>> };
} = {}) {
  const windowMinutes = normalizeNumber(minutes, 24 * 60, 1, 7 * 24 * 60);
  const rowLimit = normalizeNumber(limit, 20, 1, 100);
  const rows = await db.query('agent', `
    SELECT
      COALESCE(metadata->>'fromBot', bot_name, 'unknown') AS producer,
      team,
      COALESCE(metadata->>'alarm_type', 'unknown') AS alarm_type,
      COALESCE(metadata->>'cluster_key', metadata->>'incident_key', '') AS cluster_key,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE metadata->>'visibility' IN ('human_action', 'emergency'))::int AS escalated,
      MAX(created_at) AS latest_at
    FROM agent.event_lake
    WHERE event_type = 'hub_alarm'
      AND created_at >= NOW() - ($1::int * INTERVAL '1 minute')
    GROUP BY producer, team, alarm_type, cluster_key
    ORDER BY total DESC, escalated ASC, latest_at DESC
    LIMIT $2
  `, [windowMinutes, rowLimit]);
  return {
    ok: true,
    minutes: windowMinutes,
    limit: rowLimit,
    rows,
    message: formatNoiseReport(rows, windowMinutes),
  };
}

async function main() {
  const minutes = normalizeNumber(argValue('minutes', ''), 24 * 60, 1, 7 * 24 * 60);
  const limit = normalizeNumber(argValue('limit', ''), 20, 1, 100);
  const result = await buildAlarmNoiseReport({ minutes, limit });
  if (hasFlag('json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.message);
  }
  if (hasFlag('send')) {
    const sent = await postAlarm({
      message: result.message,
      team: 'hub',
      fromBot: 'alarm-noise-report',
      alertLevel: 1,
      alarmType: 'report',
      visibility: 'notify',
      incidentKey: `hub:alarm_noise_report:${new Date().toISOString().slice(0, 10)}`,
      eventType: 'alarm_noise_report',
      payload: {
        event_type: 'alarm_noise_report',
        row_count: result.rows.length,
      },
    });
    if (!sent?.ok) {
      throw new Error(sent?.error || 'alarm_noise_report_send_failed');
    }
  }
}

if (require.main === module) {
  main().catch((error: any) => {
    console.error('[alarm-noise-report] failed:', error?.message || error);
    process.exit(1);
  });
}

module.exports = {
  buildAlarmNoiseReport,
};
