#!/usr/bin/env tsx
'use strict';

const pgPool = require('../../../packages/core/lib/pg-pool');
const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');
const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const { loadAutoDevManifest } = require('../../../packages/core/lib/auto-dev-manifest.ts');
const { classifyAlarmTypeWithConfidence } = require('../lib/alarm/policy.ts');

const DEFAULT_AUTO_DEV_DIR = path.join(env.PROJECT_ROOT, 'docs', 'auto_dev');
const DEFAULT_COMPLETED_ARCHIVE_DIR = path.join(env.PROJECT_ROOT, 'docs', 'archive', 'codex-completed');
const RESOLVED_MANIFEST_REASON_RE = /(completed|resolved|replayed|manual|verified|current_code|current_code_patched|recovered|cleanup|skip|skipped|routed_report|routed_to_digest|missing_document|stale_resolved_live_check|stale_or_recovered|dedupe_patched|operational_noise)/i;
const CURRENT_POLICY_RESOLUTION_MIN_CONFIDENCE = 0.8;

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

function normalizeRelPath(value: unknown): string {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function repoFileExists(relPath: unknown): boolean {
  const normalized = normalizeRelPath(relPath);
  if (!normalized) return false;
  return fs.existsSync(path.join(env.PROJECT_ROOT, normalized));
}

function loadManifest(autoDevDir = DEFAULT_AUTO_DEV_DIR): Record<string, any> {
  try {
    return loadAutoDevManifest(autoDevDir);
  } catch {
    return { version: 1, updatedAt: null, entries: {} };
  }
}

function findManifestEntry(manifest: Record<string, any>, relPath: unknown): Record<string, any> | null {
  const normalized = normalizeRelPath(relPath);
  if (!normalized) return null;
  const entries = manifest?.entries && typeof manifest.entries === 'object' ? manifest.entries : {};
  if (entries[normalized]) return entries[normalized];
  return Object.values(entries).find((entry: any) => {
    return entry
      && typeof entry === 'object'
      && (normalizeRelPath(entry.relPath) === normalized || normalizeRelPath(entry.archivedPath) === normalized);
  }) as Record<string, any> | null || null;
}

function manifestResolvedReason(entry: Record<string, any> | null): string {
  if (!entry) return '';
  return [
    entry.reason,
    entry.resolvedReason,
    entry.implementationStatus,
    entry.implementation_status,
    entry.note,
  ].map((item) => String(item || '').trim()).filter(Boolean).join(' ');
}

function listArchiveCandidates(relPath: unknown, archiveDir = DEFAULT_COMPLETED_ARCHIVE_DIR): string[] {
  const normalized = normalizeRelPath(relPath);
  const basename = path.basename(normalized).replace(/\.md$/i, '');
  if (!basename) return [];
  try {
    return fs.readdirSync(archiveDir)
      .filter((name: string) => name.endsWith('.md') && name.includes(basename))
      .sort()
      .map((name: string) => normalizeRelPath(path.relative(env.PROJECT_ROOT, path.join(archiveDir, name))));
  } catch {
    return [];
  }
}

function archiveDocumentMatches(row: Record<string, any>, relPath: string): boolean {
  const incidentKey = normalizeRelPath(row.incident_key);
  if (!incidentKey) return false;
  try {
    const text = fs.readFileSync(path.join(env.PROJECT_ROOT, relPath), 'utf8');
    return text.includes(`incident_key: ${incidentKey}`)
      || text.includes(`incident_key: ${JSON.stringify(incidentKey).slice(1, -1)}`)
      || text.includes(incidentKey);
  } catch {
    return false;
  }
}

function resolveByCompletedArchive(
  row: Record<string, any>,
  archiveDir = DEFAULT_COMPLETED_ARCHIVE_DIR,
): Record<string, any> | null {
  const candidates = listArchiveCandidates(row.auto_dev_path, archiveDir);
  const matchedPath = candidates.find((candidate) => archiveDocumentMatches(row, candidate));
  if (!matchedPath) return null;
  return {
    stale_status: 'resolved_manifest',
    stale_resolution_reason: 'completed_archive_document_matches_incident',
    archived_path: matchedPath,
    archive_exists: true,
    inbox_exists: repoFileExists(row.auto_dev_path),
  };
}

function resolveByManifest(row: Record<string, any>, manifest: Record<string, any>): Record<string, any> | null {
  const entry = findManifestEntry(manifest, row.auto_dev_path);
  if (!entry) return null;

  const state = String(entry.state || '').trim();
  const reason = manifestResolvedReason(entry);
  const archiveExists = repoFileExists(entry.archivedPath);
  const inboxExists = repoFileExists(row.auto_dev_path);
  const reasonResolved = RESOLVED_MANIFEST_REASON_RE.test(reason);

  if (state === 'archived' && (archiveExists || reasonResolved)) {
    return {
      stale_status: 'resolved_manifest',
      stale_resolution_reason: archiveExists ? 'manifest_archived_file_exists' : `manifest_archived:${reason || 'no_inbox'}`,
      manifest_state: state,
      manifest_reason: reason || null,
      archived_path: normalizeRelPath(entry.archivedPath) || null,
      archive_exists: archiveExists,
      inbox_exists: inboxExists,
    };
  }

  if (state === 'archived_missing' && !inboxExists && reasonResolved) {
    return {
      stale_status: 'resolved_manifest',
      stale_resolution_reason: `manifest_archived_missing:${reason}`,
      manifest_state: state,
      manifest_reason: reason,
      archived_path: normalizeRelPath(entry.archivedPath) || null,
      archive_exists: archiveExists,
      inbox_exists: inboxExists,
    };
  }

  return null;
}

function resolveByCurrentPolicy(row: Record<string, any>): Record<string, any> | null {
  const result = classifyAlarmTypeWithConfidence({
    severity: row.severity,
    eventType: row.event_type,
    title: row.title,
    message: row.message,
  });
  if (result.type === 'error' || result.type === 'critical') return null;
  if (Number(result.confidence || 0) < CURRENT_POLICY_RESOLUTION_MIN_CONFIDENCE) return null;
  return {
    stale_status: 'resolved_current_policy',
    stale_resolution_reason: `current_policy:${result.type}`,
    current_policy_type: result.type,
    current_policy_confidence: result.confidence,
  };
}

function annotateRows(rows: Array<Record<string, any>>, {
  manifest = loadManifest(),
  archiveDir = DEFAULT_COMPLETED_ARCHIVE_DIR,
}: {
  manifest?: Record<string, any>;
  archiveDir?: string;
} = {}) {
  return rows.map((row) => {
    const manifestResolution = resolveByManifest(row, manifest);
    if (manifestResolution) return { ...row, ...manifestResolution };

    const archiveResolution = resolveByCompletedArchive(row, archiveDir);
    if (archiveResolution) return { ...row, ...archiveResolution };

    const policyResolution = resolveByCurrentPolicy(row);
    if (policyResolution) return { ...row, ...policyResolution };

    return {
      ...row,
      stale_status: 'active',
      stale_resolution_reason: null,
    };
  });
}

function formatStaleReport(rows: Array<Record<string, any>>, staleMinutes: number, resolvedRows: Array<Record<string, any>> = []): string {
  const lines = [
    '🚨 [hub] auto-repair 미해결 감시',
    `기준: ${staleMinutes}분 이상 처리 결과 없음`,
    `대상: ${rows.length}건`,
  ];
  if (resolvedRows.length > 0) {
    lines.push(`제외: ${resolvedRows.length}건 (manifest/current policy로 처리 완료 판정)`);
  }
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
  manifest,
  archiveDir,
}: {
  staleMinutes?: number;
  limit?: number;
  db?: { query: (...args: any[]) => Promise<Array<Record<string, any>>> };
  manifest?: Record<string, any>;
  archiveDir?: string;
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
        alarm.title,
        alarm.message,
        COALESCE(alarm.metadata->>'event_type', '') AS event_type,
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
      title,
      message,
      event_type,
      incident_key,
      auto_dev_path,
      created_at,
      enqueued_at
    FROM latest_by_incident
    ORDER BY enqueued_at DESC, created_at DESC
    LIMIT $2
  `, [threshold, rowLimit]);
  const annotatedRows = annotateRows(rows, { manifest, archiveDir });
  const activeRows = annotatedRows.filter((row) => row.stale_status === 'active');
  const resolvedRows = annotatedRows.filter((row) => row.stale_status !== 'active');
  return {
    ok: true,
    stale_minutes: threshold,
    limit: rowLimit,
    rows: activeRows,
    resolved_rows: resolvedRows,
    total_candidates: rows.length,
    message: formatStaleReport(activeRows, threshold, resolvedRows),
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
  _testOnly_annotateRows: annotateRows,
};
