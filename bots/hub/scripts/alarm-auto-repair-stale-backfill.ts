#!/usr/bin/env tsx
'use strict';

const pgPool = require('../../../packages/core/lib/pg-pool');
const { scanStaleAutoRepair } = require('./alarm-auto-repair-stale-scan.ts');

type BackfillStatus = 'resolved' | 'verified' | 'exhausted';
type ResultStatus = 'resolved' | 'partially_resolved' | 'unresolved_needs_human';

const APPLY_CONFIRM_TOKEN = 'hub-stale-auto-repair-backfill';

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

function normalizeText(value: unknown, fallback = ''): string {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function mirrorStatusForRow(row: Record<string, any>): BackfillStatus {
  if (row.stale_status === 'terminal_dead_letter') return 'exhausted';
  return row.stale_status === 'resolved_current_policy' ? 'verified' : 'resolved';
}

function resultStatusForRow(row: Record<string, any>): ResultStatus {
  if (row.stale_status === 'terminal_dead_letter') return 'unresolved_needs_human';
  return row.stale_status === 'resolved_current_policy' ? 'partially_resolved' : 'resolved';
}

function isApplyConfirmed(confirmToken: unknown): boolean {
  return String(confirmToken || '').trim() === APPLY_CONFIRM_TOKEN;
}

function buildBackfillPlan(rows: Array<Record<string, any>>) {
  return rows
    .map((row) => {
      const id = Number(row.id);
      const incidentKey = normalizeText(row.incident_key);
      if (!Number.isFinite(id) || id <= 0 || !incidentKey) return null;
      const mirrorStatus = mirrorStatusForRow(row);
      const resultStatus = resultStatusForRow(row);
      return {
        id,
        incident_key: incidentKey,
        team: normalizeText(row.team, 'hub'),
        bot_name: normalizeText(row.bot_name, 'unknown'),
        auto_dev_path: normalizeText(row.auto_dev_path),
        stale_status: normalizeText(row.stale_status, 'resolved_manifest'),
        stale_resolution_reason: normalizeText(row.stale_resolution_reason, 'resolved_stale_auto_repair'),
        mirror_status: mirrorStatus,
        result_status: resultStatus,
      };
    })
    .filter(Boolean) as Array<Record<string, any>>;
}

async function applyBackfillRow(row: Record<string, any>, db = pgPool) {
  return db.transaction('agent', async (client: any) => {
    const terminalFailure = row.result_status === 'unresolved_needs_human';
    const message = `Backfilled stale auto-repair row as ${row.mirror_status}: ${row.incident_key} (${row.stale_resolution_reason})`;
    const eventResult = await client.query(`
      INSERT INTO agent.event_lake (
        event_type, team, bot_name, severity, trace_id,
        title, message, tags, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::TEXT[], $9::JSONB)
      RETURNING id
    `, [
      'hub_alarm_auto_repair_result',
      row.team,
      'alarm-stale-auto-repair-backfill',
      terminalFailure ? 'warn' : 'info',
      row.incident_key,
      'Alarm auto repair stale backfill',
      message,
      ['hub', 'alarm', 'auto_repair_result', 'stale_backfill', `team:${row.team}`],
      JSON.stringify({
        source: 'stale_auto_repair_backfill',
        incident_key: row.incident_key,
        status: row.result_status,
        mirror_status: row.mirror_status,
        doc_path: row.auto_dev_path || null,
        stale_status: row.stale_status,
        stale_resolution_reason: row.stale_resolution_reason,
        backfill: true,
      }),
    ]);
    const eventId = eventResult.rows?.[0]?.id || null;

    const updateResult = await client.query(`
      UPDATE agent.hub_alarms
      SET status = $1,
          resolved_at = CASE WHEN $1 = 'exhausted' THEN resolved_at ELSE COALESCE(resolved_at, NOW()) END,
          metadata = COALESCE(metadata, '{}') || jsonb_build_object(
            'auto_repair_backfill_status', $2::text,
            'auto_repair_backfill_result_status', $3::text,
            'auto_repair_backfill_reason', $4::text,
            'auto_repair_backfill_event_id', $5::text,
            'auto_repair_backfill_at', NOW()::text
          )
      WHERE id = $6
        AND COALESCE(status, '') IN ('repairing', 'correlating')
        AND COALESCE(actionability, '') = 'auto_repair'
      RETURNING id, status
    `, [
      row.mirror_status,
      row.mirror_status,
      row.result_status,
      row.stale_resolution_reason,
      String(eventId || ''),
      row.id,
    ]);

    if (Number(updateResult.rowCount || 0) !== 1) {
      throw new Error(`hub_alarm_backfill_update_mismatch:id=${row.id}:rowCount=${updateResult.rowCount || 0}`);
    }

    return {
      id: row.id,
      incident_key: row.incident_key,
      event_id: eventId,
      status: updateResult.rows?.[0]?.status || row.mirror_status,
    };
  });
}

export async function backfillResolvedStaleAutoRepair({
  staleMinutes = 120,
  limit = 100,
  maxBatches = 5,
  apply = false,
  confirm = '',
  db = pgPool,
}: {
  staleMinutes?: number;
  limit?: number;
  maxBatches?: number;
  apply?: boolean;
  confirm?: string;
  db?: typeof pgPool;
} = {}) {
  const threshold = normalizeNumber(staleMinutes, 120, 5, 7 * 24 * 60);
  const rowLimit = normalizeNumber(limit, 100, 1, 100);
  const batchLimit = normalizeNumber(maxBatches, 5, 1, 20);
  if (apply && !isApplyConfirmed(confirm)) {
    return {
      ok: false,
      status: 'confirm_required',
      apply: false,
      requested_apply: true,
      confirm_token: APPLY_CONFIRM_TOKEN,
      stale_minutes: threshold,
      limit: rowLimit,
      max_batches: batchLimit,
      active_rows_seen: 0,
      resolved_rows_seen: 0,
      total_candidates_seen: 0,
      planned_count: 0,
      applied_count: 0,
      planned: [],
      applied: [],
    };
  }
  const applied: Array<Record<string, any>> = [];
  const planned: Array<Record<string, any>> = [];
  let activeRows = 0;
  let resolvedRows = 0;
  let totalCandidates = 0;

  for (let batch = 0; batch < batchLimit; batch += 1) {
    const scan = await scanStaleAutoRepair({ staleMinutes: threshold, limit: rowLimit, db });
    activeRows += Number(scan.rows?.length || 0);
    resolvedRows += Number(scan.resolved_rows?.length || 0);
    totalCandidates += Number(scan.total_candidates || 0);
    const plan = buildBackfillPlan(scan.resolved_rows || []);
    planned.push(...plan);

    if (!apply || plan.length === 0) break;
    for (const row of plan) {
      applied.push(await applyBackfillRow(row, db));
    }
  }

  return {
    ok: true,
    apply,
    stale_minutes: threshold,
    limit: rowLimit,
    max_batches: batchLimit,
    active_rows_seen: activeRows,
    resolved_rows_seen: resolvedRows,
    total_candidates_seen: totalCandidates,
    planned_count: planned.length,
    applied_count: applied.length,
    planned,
    applied,
  };
}

async function main() {
  const result = await backfillResolvedStaleAutoRepair({
    staleMinutes: normalizeNumber(argValue('stale-minutes', ''), 120, 5, 7 * 24 * 60),
    limit: normalizeNumber(argValue('limit', ''), 100, 1, 100),
    maxBatches: normalizeNumber(argValue('max-batches', ''), 5, 1, 20),
    apply: hasFlag('apply'),
    confirm: argValue('confirm', ''),
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.ok === false) process.exit(2);
}

if (require.main === module) {
  main().catch((error: any) => {
    console.error('[alarm-auto-repair-stale-backfill] failed:', error?.message || error);
    process.exit(1);
  });
}

module.exports = {
  APPLY_CONFIRM_TOKEN,
  backfillResolvedStaleAutoRepair,
  _testOnly_buildBackfillPlan: buildBackfillPlan,
  _testOnly_isApplyConfirmed: isApplyConfirmed,
};
