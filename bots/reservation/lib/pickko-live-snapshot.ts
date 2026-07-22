// @ts-nocheck
'use strict';

const fs = require('node:fs');
const {
  ensureParentDir,
  getReservationRuntimeFile,
} = require('./runtime-paths');

const PICKKO_LIVE_SNAPSHOT_VERSION = 1;
const PICKKO_LIVE_SNAPSHOT_MAX_AGE_MS = 30 * 60 * 60 * 1000;
const TRUSTED_SNAPSHOT_FILE = 'pickko-live-sync-snapshot.json';
const LATEST_ATTEMPT_FILE = 'pickko-live-sync-attempt.json';

function normalizeRoom(value) {
  const text = String(value || '').toUpperCase();
  if (text.includes('A1')) return 'A1';
  if (text.includes('A2')) return 'A2';
  if (text.includes('B')) return 'B';
  return text.trim();
}

function normalizeClock(value) {
  return String(value || '').slice(0, 5);
}

function compactPaidEntries(entries = []) {
  const compact = [];
  const seen = new Set();
  for (const entry of entries) {
    const row = {
      date: String(entry?.date || '').slice(0, 10),
      start: normalizeClock(entry?.start),
      end: normalizeClock(entry?.end),
      room: normalizeRoom(entry?.room),
      status: 'paid',
    };
    if (!row.date || !row.start || !row.room) continue;
    const key = `${row.date}|${row.room}|${row.start}|${row.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    compact.push(row);
  }
  return compact;
}

function resolveSnapshotPaths(options = {}) {
  return {
    snapshotPath: options.snapshotPath || getReservationRuntimeFile(TRUSTED_SNAPSHOT_FILE),
    attemptPath: options.attemptPath || getReservationRuntimeFile(LATEST_ATTEMPT_FILE),
  };
}

function writeJsonAtomic(filePath, payload) {
  ensureParentDir(filePath);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch {}
    throw error;
  }
}

function buildSnapshotPayload(input = {}) {
  const entries = compactPaidEntries(input.entries);
  return {
    version: PICKKO_LIVE_SNAPSHOT_VERSION,
    collectedAt: String(input.collectedAt || new Date().toISOString()),
    coverage: {
      from: String(input.coverageFrom || '').slice(0, 10),
      to: String(input.coverageTo || '').slice(0, 10),
      complete: input.complete === true,
    },
    fetchOk: input.fetchOk === true,
    entryCount: entries.length,
    entries,
  };
}

function persistPickkoLiveSnapshot(input = {}, options = {}) {
  const paths = resolveSnapshotPaths(options);
  const payload = buildSnapshotPayload(input);
  writeJsonAtomic(paths.attemptPath, payload);
  const trustedUpdated = payload.fetchOk && payload.coverage.complete;
  if (trustedUpdated) writeJsonAtomic(paths.snapshotPath, payload);
  return { trustedUpdated, ...paths, payload };
}

function loadPickkoLiveSnapshot(options = {}) {
  const { snapshotPath } = resolveSnapshotPaths(options);
  try {
    return JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  } catch {
    return null;
  }
}

function assessPickkoLiveSnapshot(snapshot, options = {}) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { usable: false, reason: 'pickko_snapshot_missing' };
  }
  if (snapshot.version !== PICKKO_LIVE_SNAPSHOT_VERSION
    || snapshot.fetchOk !== true
    || snapshot.coverage?.complete !== true
    || !Array.isArray(snapshot.entries)) {
    return { usable: false, reason: 'pickko_snapshot_invalid' };
  }

  const collectedAtMs = Date.parse(snapshot.collectedAt);
  if (!Number.isFinite(collectedAtMs)) {
    return { usable: false, reason: 'pickko_snapshot_invalid' };
  }
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const maxAgeMs = Number.isFinite(options.maxAgeMs)
    ? options.maxAgeMs
    : PICKKO_LIVE_SNAPSHOT_MAX_AGE_MS;
  const ageMs = Math.max(0, nowMs - collectedAtMs);
  if (ageMs > maxAgeMs) {
    return { usable: false, reason: 'pickko_snapshot_stale', ageMs, collectedAtMs };
  }

  const from = String(options.from || '').slice(0, 10);
  const to = String(options.to || from).slice(0, 10);
  if (!snapshot.coverage?.from
    || !snapshot.coverage?.to
    || snapshot.coverage.from > from
    || snapshot.coverage.to < to) {
    return { usable: false, reason: 'pickko_snapshot_coverage_gap', ageMs, collectedAtMs };
  }

  return { usable: true, reason: null, ageMs, collectedAtMs };
}

module.exports = {
  LATEST_ATTEMPT_FILE,
  PICKKO_LIVE_SNAPSHOT_MAX_AGE_MS,
  PICKKO_LIVE_SNAPSHOT_VERSION,
  TRUSTED_SNAPSHOT_FILE,
  assessPickkoLiveSnapshot,
  buildSnapshotPayload,
  compactPaidEntries,
  loadPickkoLiveSnapshot,
  persistPickkoLiveSnapshot,
  resolveSnapshotPaths,
};
