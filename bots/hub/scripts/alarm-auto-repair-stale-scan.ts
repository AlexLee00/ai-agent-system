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

function formatStaleReport(rows: Array<Record<string, any>>, staleMinutes: number): string {
  const lines = [
    '🚨 [hub] auto-repair 미해결 감시',
    `기준: ${staleMinutes}분 이상 처리 결과 없음`,
    `대상: ${rows.length}건`,
  ];
  for (const row of rows.slice(0, 8)) {
    lines.push(`- ${row.team}/${row.bot_name}: ${row.incident_key} (${row.created_at})`);
  }
  if (rows.length === 0) lines.push('상태: stale auto-repair 없음');
  return lines.join('\n');
}

export async function scanStaleAutoRepair({
  staleMinutes = 120,
  limit = 20,
}: {
  staleMinutes?: number;
  limit?: number;
} = {}) {
  const threshold = normalizeNumber(staleMinutes, 120, 5, 7 * 24 * 60);
  const rowLimit = normalizeNumber(limit, 20, 1, 100);
  const rows = await pgPool.query('agent', `
    SELECT
      alarm.id,
      alarm.team,
      alarm.bot_name,
      alarm.severity,
      alarm.message,
      alarm.metadata->>'incident_key' AS incident_key,
      alarm.metadata->>'auto_dev_path' AS auto_dev_path,
      alarm.created_at
    FROM agent.event_lake alarm
    WHERE alarm.event_type = 'hub_alarm'
      AND alarm.metadata->>'actionability' = 'auto_repair'
      AND COALESCE(alarm.metadata->>'status', '') = 'repairing'
      AND alarm.created_at < NOW() - ($1::int * INTERVAL '1 minute')
      AND NOT EXISTS (
        SELECT 1
        FROM agent.event_lake result
        WHERE result.event_type = 'hub_alarm_auto_repair_result'
          AND result.metadata->>'incident_key' = alarm.metadata->>'incident_key'
      )
    ORDER BY alarm.created_at ASC
    LIMIT $2
  `, [threshold, rowLimit]);
  return {
    ok: true,
    stale_minutes: threshold,
    limit: rowLimit,
    rows,
    message: formatStaleReport(rows, threshold),
  };
}

async function main() {
  const staleMinutes = normalizeNumber(argValue('stale-minutes', ''), 120, 5, 7 * 24 * 60);
  const limit = normalizeNumber(argValue('limit', ''), 20, 1, 100);
  const result = await scanStaleAutoRepair({ staleMinutes, limit });
  if (hasFlag('json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.message);
  }
  if (hasFlag('send') && result.rows.length > 0) {
    const sent = await postAlarm({
      message: result.message,
      team: 'hub',
      fromBot: 'alarm-auto-repair-stale-scan',
      alertLevel: 3,
      alarmType: 'error',
      visibility: 'human_action',
      actionability: 'needs_human',
      incidentKey: `hub:stale_auto_repair:${new Date().toISOString().slice(0, 10)}`,
      payload: {
        event_type: 'stale_auto_repair_scan',
        stale_count: result.rows.length,
      },
    });
    if (!sent?.ok) {
      throw new Error(sent?.error || 'stale_auto_repair_send_failed');
    }
  }
}

if (require.main === module) {
  main().catch((error: any) => {
    console.error('[alarm-auto-repair-stale-scan] failed:', error?.message || error);
    process.exit(1);
  });
}

module.exports = {
  scanStaleAutoRepair,
};

