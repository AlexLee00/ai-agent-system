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
  if (value == null || String(value).trim() === '') return fallback;
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
  db = pgPool,
}: {
  staleMinutes?: number;
  limit?: number;
  db?: { query: (...args: any[]) => Promise<Array<Record<string, any>>> };
} = {}) {
  const threshold = normalizeNumber(staleMinutes, 120, 5, 7 * 24 * 60);
  const rowLimit = normalizeNumber(limit, 20, 1, 100);
  const rows = await db.query('agent', `
    WITH candidates AS (
      SELECT
        alarm.id,
        alarm.team,
        alarm.bot_name,
        alarm.severity,
        alarm.message,
        COALESCE(alarm.metadata->>'incident_key', alarm.fingerprint) AS incident_key,
        enqueued.metadata->>'auto_dev_path' AS auto_dev_path,
        alarm.received_at AS created_at,
        enqueued.created_at AS enqueued_at
      FROM agent.hub_alarms alarm
      JOIN LATERAL (
        SELECT event.metadata, event.created_at
        FROM agent.event_lake event
        WHERE event.event_type = 'hub_alarm_auto_repair_enqueued'
          AND event.metadata->>'incident_key' = COALESCE(alarm.metadata->>'incident_key', alarm.fingerprint)
        ORDER BY event.created_at DESC
        LIMIT 1
      ) enqueued ON TRUE
      WHERE COALESCE(alarm.actionability, '') = 'auto_repair'
        AND COALESCE(alarm.status, '') IN ('repairing', 'correlating')
        AND alarm.received_at < NOW() - ($1::int * INTERVAL '1 minute')
        AND COALESCE(alarm.metadata->>'auto_repair_shadow_skipped', 'false') <> 'true'
        AND COALESCE(alarm.metadata->>'event_type', '') NOT LIKE 'auto_dev_%'
        AND NOT EXISTS (
          SELECT 1
          FROM agent.event_lake result
          WHERE result.event_type = 'hub_alarm_auto_repair_result'
            AND result.metadata->>'incident_key' = COALESCE(alarm.metadata->>'incident_key', alarm.fingerprint)
            AND result.created_at >= enqueued.created_at
        )
    ), latest_by_incident AS (
      SELECT DISTINCT ON (incident_key) *
      FROM candidates
      ORDER BY incident_key, enqueued_at DESC, created_at DESC
    )
    SELECT
      id,
      team,
      bot_name,
      severity,
      message,
      incident_key,
      auto_dev_path,
      created_at,
      enqueued_at
    FROM latest_by_incident
    ORDER BY enqueued_at DESC, created_at DESC
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
      eventType: 'stale_auto_repair_scan',
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
