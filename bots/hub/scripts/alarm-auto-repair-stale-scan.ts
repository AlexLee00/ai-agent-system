#!/usr/bin/env tsx
'use strict';

const pgPool = require('../../../packages/core/lib/pg-pool');
const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const env = require('../../../packages/core/lib/env');
const { loadAutoDevManifest } = require('../../../packages/core/lib/auto-dev-manifest.ts');
const { classifyAlarmTypeWithConfidence } = require('../lib/alarm/policy.ts');
const { decrypt } = require('../../reservation/lib/crypto.ts');
const { normalizeStudyRoomKey } = require('../../reservation/lib/study-room-pricing.ts');

const DEFAULT_AUTO_DEV_DIR = path.join(env.PROJECT_ROOT, 'docs', 'auto_dev');
const DEFAULT_COMPLETED_ARCHIVE_DIR = path.join(env.PROJECT_ROOT, 'docs', 'archive', 'codex-completed');
const CURRENT_POLICY_RESOLUTION_MIN_CONFIDENCE = 0.8;
const STALE_SCAN_MAX_CANDIDATES = 1000;
const STALE_ALERT_DEDUPE_MINUTES = 24 * 60;

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

function isResolvedManifestReason(value: unknown): boolean {
  const reason = String(value || '').trim().toLowerCase();
  if (!reason) return false;
  const tokens = reason.split(/[_\s:-]+/).filter(Boolean);
  const negativeTokens = new Set([
    'not', 'unresolved', 'failed', 'failure', 'error', 'pending', 'blocked',
    'dead', 'letter', 'required', 'requires', 'needed', 'needs',
  ]);
  if (tokens.some((token) => negativeTokens.has(token))) return false;

  const resolvedTokens = new Set([
    'completed', 'resolved', 'verified', 'recovered', 'recovery', 'patched',
    'cleanup', 'archived', 'replayed', 'skip', 'skipped', 'suppressed', 'passed',
  ]);
  if (tokens.some((token) => resolvedTokens.has(token))) return true;
  return new Set([
    'missing_document',
    'operational_noise',
    'routed_report',
    'routed_to_digest',
  ]).has(reason);
}

function hashRepoFile(relPath: unknown): string {
  const normalized = normalizeRelPath(relPath);
  if (!normalized) return '';
  try {
    return crypto.createHash('sha1')
      .update(fs.readFileSync(path.join(env.PROJECT_ROOT, normalized), 'utf8'))
      .digest('hex')
      .slice(0, 16);
  } catch {
    return '';
  }
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
    entry.resolutionReason,
    entry.implementationStatus,
    entry.implementation_status,
    entry.note,
  ].map((item) => String(item || '').trim()).filter(Boolean).join(' ');
}

function manifestEntryHasResolvedReason(entry: Record<string, any> | null): boolean {
  if (!entry) return false;
  return [
    entry.reason,
    entry.resolvedReason,
    entry.resolutionReason,
    entry.implementationStatus,
    entry.implementation_status,
  ].some((item) => isResolvedManifestReason(item));
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
  return documentMatchesIncident(row, path.join(env.PROJECT_ROOT, relPath));
}

function documentMatchesIncident(row: Record<string, any>, filePath: string): boolean {
  const incidentKey = String(row.incident_key || '').trim();
  if (!incidentKey) return false;
  try {
    const text = fs.readFileSync(filePath, 'utf8');
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
  if (repoFileExists(row.auto_dev_path)) return null;
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

function resolveByManifest(
  row: Record<string, any>,
  manifest: Record<string, any>,
  processedDir = path.join(DEFAULT_AUTO_DEV_DIR, 'processed'),
): Record<string, any> | null {
  const entry = findManifestEntry(manifest, row.auto_dev_path);
  if (!entry) return null;

  const state = String(entry.state || '').trim();
  const reason = manifestResolvedReason(entry);
  const archiveExists = repoFileExists(entry.archivedPath);
  const inboxExists = repoFileExists(row.auto_dev_path);
  const reasonResolved = manifestEntryHasResolvedReason(entry);
  if (inboxExists) {
    const manifestHash = String(entry.contentHash || '').trim();
    const inboxHash = hashRepoFile(row.auto_dev_path);
    if (!manifestHash || !inboxHash || manifestHash !== inboxHash) return null;
  }

  if (state === 'dead_letter' && entry.deadLetteredAt && !inboxExists) {
    const explicitProcessedPath = String(entry.processedPath || '').trim();
    const contentHash = String(entry.contentHash || '').trim();
    const baseName = path.basename(normalizeRelPath(row.auto_dev_path)).replace(/\.md$/i, '');
    const processedCandidates = [
      explicitProcessedPath
        ? (path.isAbsolute(explicitProcessedPath)
          ? explicitProcessedPath
          : path.join(env.PROJECT_ROOT, normalizeRelPath(explicitProcessedPath)))
        : '',
      contentHash && baseName ? path.join(processedDir, `${baseName}.${contentHash}.md`) : '',
    ].filter(Boolean);
    const matchedProcessedPath = processedCandidates.find((candidate) => {
      return fs.existsSync(candidate) && documentMatchesIncident(row, candidate);
    });
    if (matchedProcessedPath) {
      return {
        stale_status: 'terminal_dead_letter',
        stale_resolution_reason: 'auto_dev_dead_letter_result_recorded',
        manifest_state: state,
        dead_lettered_at: entry.deadLetteredAt,
        processed_path: normalizeRelPath(path.relative(env.PROJECT_ROOT, matchedProcessedPath)),
        inbox_exists: false,
      };
    }
  }

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

function normalizePhoneDigits(value: unknown): string {
  return String(value || '').replace(/\D/g, '');
}

function extractReservationPhoneDigits(row: Record<string, any>): string | null {
  const text = `${row.message || ''}\n${row.title || ''}`;
  const match = text.match(/(?:📞\s*)?(?:번호|전화번호)\s*[:：]\s*([0-9][0-9\-\s]{8,})/);
  const digits = normalizePhoneDigits(match?.[1] || '');
  return digits.length >= 10 ? digits : null;
}

function parseReservationNaverBlockRetry(row: Record<string, any>): Record<string, any> | null {
  const incidentKey = String(row.incident_key || '');
  if (row.team !== 'reservation' || !incidentKey.includes(':naver_block_retry:')) return null;
  const parts = incidentKey.split(':');
  const datePart = parts.find((part) => /^20\d{2}_\d{2}_\d{2}$/.test(part));
  const timePart = parts.find((part) => /^\d{4}_\d{4}$/.test(part));
  const phoneSuffix = parts.find((part) => /^\d{4}$/.test(part));
  const roomPart = parts.find((part) => normalizeStudyRoomKey(part));
  const phoneDigits = extractReservationPhoneDigits(row);
  if (!datePart || !timePart || !phoneSuffix || !roomPart || !phoneDigits) return null;
  if (!phoneDigits.endsWith(phoneSuffix)) return null;
  const [startRaw, endRaw] = timePart.split('_');
  return {
    date: datePart.replace(/_/g, '-'),
    start: `${startRaw.slice(0, 2)}:${startRaw.slice(2)}`,
    end: `${endRaw.slice(0, 2)}:${endRaw.slice(2)}`,
    roomKey: normalizeStudyRoomKey(roomPart),
    phoneDigits,
  };
}

async function resolveByReservationCurrentState(row: Record<string, any>, db = pgPool): Promise<Record<string, any> | null> {
  const parsed = parseReservationNaverBlockRetry(row);
  if (!parsed) return null;
  const rows = await db.query('reservation', `
    SELECT phone_raw_enc, date, start_time, end_time, room, naver_blocked, blocked_at, last_block_result, last_block_reason
    FROM reservation.kiosk_blocks
    WHERE date = $1
      AND start_time = $2
      AND end_time = $3
      AND naver_blocked = 1
  `, [parsed.date, parsed.start, parsed.end]);
  const matched = rows.find((candidate: Record<string, any>) => {
    if (normalizeStudyRoomKey(candidate.room) !== parsed.roomKey) return false;
    try {
      return normalizePhoneDigits(decrypt(candidate.phone_raw_enc)) === parsed.phoneDigits;
    } catch {
      return false;
    }
  });
  if (!matched) return null;
  return {
    stale_status: 'resolved_current_state',
    stale_resolution_reason: `reservation_kiosk_blocked:${parsed.date}:${parsed.roomKey}:${parsed.start}_${parsed.end}`,
    current_state_table: 'reservation.kiosk_blocks',
    current_state_last_block_result: matched.last_block_result || null,
    current_state_last_block_reason: matched.last_block_reason || null,
    current_state_blocked_at: matched.blocked_at || null,
  };
}

function annotateRows(rows: Array<Record<string, any>>, {
  manifest = loadManifest(),
  archiveDir = DEFAULT_COMPLETED_ARCHIVE_DIR,
  processedDir = path.join(DEFAULT_AUTO_DEV_DIR, 'processed'),
}: {
  manifest?: Record<string, any>;
  archiveDir?: string;
  processedDir?: string;
} = {}) {
  return rows.map((row) => {
    const manifestResolution = resolveByManifest(row, manifest, processedDir);
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

async function resolveRowsByCurrentState(
  rows: Array<Record<string, any>>,
  db = pgPool,
): Promise<Array<Record<string, any>>> {
  const resolvedRows = [];
  for (const row of rows) {
    if (row.stale_status !== 'active') {
      resolvedRows.push(row);
      continue;
    }
    const currentStateResolution = await resolveByReservationCurrentState(row, db);
    resolvedRows.push(currentStateResolution ? { ...row, ...currentStateResolution } : row);
  }
  return resolvedRows;
}

function formatStaleReport(rows: Array<Record<string, any>>, staleMinutes: number, resolvedRows: Array<Record<string, any>> = []): string {
  const lines = [
    '🚨 [hub] auto-repair 미해결 감시',
    `기준: ${staleMinutes}분 이상 처리 결과 없음`,
    `대상: ${rows.length}건`,
  ];
  if (resolvedRows.length > 0) {
    lines.push(`제외: ${resolvedRows.length}건 (manifest/current policy/terminal state로 처리 결과 판정)`);
  }
  for (const row of rows.slice(0, 8)) {
    lines.push(`- ${row.team}/${row.bot_name}: ${row.incident_key} (${row.created_at})`);
  }
  if (rows.length === 0) lines.push('상태: stale auto-repair 없음');
  return lines.join('\n');
}

function buildActiveIncidentFingerprint(rows: Array<Record<string, any>>): string {
  const members = [...new Set((rows || []).map((row) => {
    const incidentKey = String(row.incident_key || '').trim();
    const generation = String(row.enqueue_event_id || row.enqueued_at || '').trim();
    return incidentKey ? `${incidentKey}|${generation}` : '';
  }).filter(Boolean))].sort();
  return crypto.createHash('sha256').update(members.join('\n')).digest('hex');
}

function buildStaleAlarmInput(result: Record<string, any>): Record<string, any> {
  const fingerprint = String(result.active_fingerprint || buildActiveIncidentFingerprint(result.rows || []));
  const activeCount = Number(result.active_count ?? result.rows?.length ?? 0);
  return {
    message: result.message,
    team: 'hub',
    fromBot: 'alarm-auto-repair-stale-scan',
    alertLevel: 3,
    alarmType: 'error',
    visibility: 'human_action',
    actionability: 'needs_human',
    incidentKey: `hub:stale_auto_repair:${fingerprint.slice(0, 16)}`,
    eventType: 'stale_auto_repair_scan',
    dedupeMinutes: STALE_ALERT_DEDUPE_MINUTES,
    payload: {
      event_type: 'stale_auto_repair_scan',
      stale_count: activeCount,
      active_fingerprint: fingerprint,
      total_candidates: Number(result.total_candidates || 0),
      truncated: Boolean(result.truncated),
    },
  };
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
  const pageSize = Math.max(20, rowLimit);
  const manifestSnapshot = manifest || loadManifest();
  const candidateRows: Array<Record<string, any>> = [];
  const activeRows: Array<Record<string, any>> = [];
  const resolvedRows: Array<Record<string, any>> = [];
  let offset = 0;
  let truncated = false;

  while (offset < STALE_SCAN_MAX_CANDIDATES) {
    const rows = await db.query('agent', `
    WITH generations AS (
      SELECT
        alarm.id,
        alarm.team,
        alarm.bot_name,
        alarm.status AS alarm_status,
        alarm.severity,
        alarm.title,
        alarm.message,
        COALESCE(alarm.metadata->>'event_type', '') AS event_type,
        COALESCE(alarm.metadata->>'incident_key', alarm.fingerprint) AS incident_key,
        alarm.metadata->>'event_id' AS alarm_event_id,
        enqueued.id AS enqueue_event_id,
        enqueued.metadata->>'auto_dev_path' AS auto_dev_path,
        alarm.received_at AS created_at,
        enqueued.created_at AS enqueued_at
      FROM agent.hub_alarms alarm
      JOIN LATERAL (
        SELECT event.id, event.metadata, event.created_at
        FROM agent.event_lake event
        WHERE event.event_type = 'hub_alarm_auto_repair_enqueued'
          AND event.metadata->>'incident_key' = COALESCE(alarm.metadata->>'incident_key', alarm.fingerprint)
          AND event.metadata->>'alarm_event_id' = alarm.metadata->>'event_id'
          AND COALESCE(event.metadata->>'created', 'true') = 'true'
        ORDER BY event.created_at DESC
        LIMIT 1
      ) enqueued ON TRUE
      WHERE COALESCE(alarm.actionability, '') = 'auto_repair'
        AND COALESCE(alarm.metadata->>'auto_repair_shadow_skipped', 'false') <> 'true'
        AND COALESCE(alarm.metadata->>'event_type', '') NOT LIKE 'auto_dev_%'
    ), latest_by_incident AS (
      SELECT DISTINCT ON (incident_key) *
      FROM generations
      ORDER BY incident_key, created_at DESC, enqueued_at DESC NULLS LAST
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
      alarm_event_id,
      enqueue_event_id,
      auto_dev_path,
      created_at,
      enqueued_at
    FROM latest_by_incident
    WHERE COALESCE(alarm_status, '') IN ('repairing', 'correlating')
      AND enqueued_at < NOW() - ($1::int * INTERVAL '1 minute')
      AND NOT EXISTS (
        SELECT 1
        FROM agent.event_lake result
        WHERE result.event_type = 'hub_alarm_auto_repair_result'
          AND result.metadata->>'incident_key' = latest_by_incident.incident_key
          AND result.metadata->>'alarm_event_id' = latest_by_incident.alarm_event_id
          AND result.metadata->>'callback_committed' = 'true'
          AND result.created_at >= latest_by_incident.enqueued_at
      )
    ORDER BY enqueued_at DESC, created_at DESC
    LIMIT $2 OFFSET $3
    `, [threshold, pageSize, offset]);
    candidateRows.push(...rows);
    const initiallyAnnotatedRows = annotateRows(rows, { manifest: manifestSnapshot, archiveDir });
    const annotatedRows = await resolveRowsByCurrentState(initiallyAnnotatedRows, db);
    activeRows.push(...annotatedRows.filter((row) => row.stale_status === 'active'));
    resolvedRows.push(...annotatedRows.filter((row) => row.stale_status !== 'active'));
    offset += rows.length;
    if (rows.length < pageSize) break;
    if (offset >= STALE_SCAN_MAX_CANDIDATES) truncated = true;
  }

  const activeFingerprint = buildActiveIncidentFingerprint(activeRows);
  return {
    ok: true,
    stale_minutes: threshold,
    limit: rowLimit,
    rows: activeRows.slice(0, rowLimit),
    active_count: activeRows.length,
    active_fingerprint: activeFingerprint,
    resolved_rows: resolvedRows,
    total_candidates: candidateRows.length,
    truncated,
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
  if (hasFlag('send') && result.active_count > 0) {
    const sent = await postAlarm(buildStaleAlarmInput(result));
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
  _testOnly_buildActiveIncidentFingerprint: buildActiveIncidentFingerprint,
  _testOnly_buildStaleAlarmInput: buildStaleAlarmInput,
  _testOnly_isResolvedManifestReason: isResolvedManifestReason,
};
