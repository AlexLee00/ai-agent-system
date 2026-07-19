// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const env = require('./env');

const MANIFEST_FILE_NAME = '.auto-dev-manifest.json';
const AUTO_DEV_FILE_PREFIXES = ['ALARM_INCIDENT_', 'CODEX_', 'PATCH_REQUEST'];
const DEFAULT_MANIFEST_LOCK_STALE_MS = 2 * 60 * 1000;
const DEFAULT_MANIFEST_LOCK_WAIT_MS = 2 * 1000;
const DEFAULT_MANIFEST_LOCK_RETRY_MS = 25;
const MANIFEST_RECLAIM_GUARD_ATTEMPTS = 2;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const MANIFEST_LOCK_STALE_MS = positiveInteger(
  process.env.CLAUDE_AUTO_DEV_MANIFEST_LOCK_STALE_MS,
  DEFAULT_MANIFEST_LOCK_STALE_MS,
);
const MANIFEST_LOCK_WAIT_MS = positiveInteger(
  process.env.CLAUDE_AUTO_DEV_MANIFEST_LOCK_WAIT_MS,
  DEFAULT_MANIFEST_LOCK_WAIT_MS,
);
const MANIFEST_LOCK_RETRY_MS = positiveInteger(
  process.env.CLAUDE_AUTO_DEV_MANIFEST_LOCK_RETRY_MS,
  DEFAULT_MANIFEST_LOCK_RETRY_MS,
);

function getProjectRoot() {
  const override = String(process.env.PROJECT_ROOT || process.env.CODEX_PROJECT_ROOT || '').trim();
  return override || env.PROJECT_ROOT;
}

function normalizeRelPath(relPath) {
  return String(relPath || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function manifestPathForDir(autoDevDir) {
  return path.join(autoDevDir, MANIFEST_FILE_NAME);
}

function resolveAutoDevStateFile(options = {}) {
  const configured = String(
    options.autoDevStateFile
    || options.stateFile
    || process.env.CLAUDE_AUTO_DEV_STATE_FILE
    || process.env.CLAUDE_AUTO_DEV_STATE_PATH
    || ''
  ).trim();
  return configured || null;
}

function isAutoDevInboxMarkdown(name) {
  const normalized = String(name || '').trim();
  return Boolean(
    normalized.endsWith('.md')
    && !normalized.startsWith('.')
    && AUTO_DEV_FILE_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

function loadCompletedAutoDevRelPaths(options = {}) {
  const stateFile = resolveAutoDevStateFile(options);
  if (!stateFile) return new Set();
  try {
    if (!fs.existsSync(stateFile)) return new Set();
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const jobs = parsed?.jobs && typeof parsed.jobs === 'object' ? Object.values(parsed.jobs) : [];
    return new Set(
      jobs
        .filter((job) => job && typeof job === 'object')
        .filter((job) => String(job.status || '') === 'completed')
        .map((job) => normalizeRelPath(job.relPath || ''))
        .filter(Boolean)
    );
  } catch {
    return new Set();
  }
}

function hasCompletedManifestRecord(entry) {
  const reason = String(entry?.reason || '').trim();
  const implementationStatus = String(entry?.implementationStatus || entry?.implementation_status || '').trim();
  return Boolean(
    ['completed', 'already_completed', 'implementation_completed', 'auto_dev_implementation_completed', 'auto_dev_current_state_resolved'].includes(reason)
    || ['completed', 'done', 'implementation_completed', 'auto_dev_implementation_completed'].includes(implementationStatus)
  );
}

function isActiveAutoDevState(state) {
  return ['inbox', 'claimed', 'active', 'failed'].includes(String(state || ''));
}

function hasCompletedAutoDevHistory(relPath, entry, completedRelPaths) {
  const normalized = normalizeRelPath(relPath);
  return Boolean(
    normalized
    && (
      completedRelPaths.has(normalized)
      || hasCompletedManifestRecord(entry)
    )
  );
}

function hashAutoDevContent(content) {
  return crypto.createHash('sha1').update(String(content || '')).digest('hex').slice(0, 16);
}

function hashAutoDevFile(filePath) {
  const normalized = normalizeRelPath(filePath);
  if (!normalized) return '';
  const absolute = path.isAbsolute(filePath) ? filePath : path.join(getProjectRoot(), normalized);
  try {
    return hashAutoDevContent(fs.readFileSync(absolute, 'utf8'));
  } catch {
    return '';
  }
}

function manifestContentHash(entry) {
  return String(entry?.contentHash || '').trim() || hashAutoDevFile(entry?.archivedPath || '');
}

function resetTerminalManifestEntry(entry, contentHash, source) {
  const {
    archivedAt,
    archivedBy,
    archivedPath,
    reason,
    note,
    resolvedReason,
    resolutionReason,
    implementationStatus,
    implementation_status,
    implementationCompletedAt,
    completedAt,
    completedNoRequeueAt,
    deadLetteredAt,
    processedPath,
    failureClass,
    lastError,
    failedAt,
    failureReason,
    rootInboxRemovedAt,
    rootInboxRemovedBy,
    rootInboxArchivedCopy,
    rootInboxCleanupReason,
    duplicateCleanupAt,
    callbackState,
    callbackPayload,
    callbackAttempts,
    callbackLastAttemptAt,
    callbackNextAttemptAt,
    callbackDeliveredAt,
    callbackEventId,
    callbackError,
    ...rest
  } = entry || {};
  const now = new Date().toISOString();
  return {
    ...rest,
    state: 'inbox',
    source,
    contentHash,
    createdAt: now,
    updatedAt: now,
  };
}

function loadAutoDevManifest(autoDevDir) {
  const manifestPath = manifestPathForDir(autoDevDir);
  try {
    if (!fs.existsSync(manifestPath)) {
      return { version: 1, updatedAt: null, entries: {} };
    }
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return {
      version: 1,
      updatedAt: parsed?.updatedAt || null,
      entries: parsed?.entries && typeof parsed.entries === 'object' ? parsed.entries : {},
    };
  } catch {
    return { version: 1, updatedAt: null, entries: {} };
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readManifestLockOwner(lockPath) {
  try {
    const token = String(fs.readFileSync(lockPath, 'utf8') || '').trim();
    const pid = Number(token.split(':', 1)[0]);
    return { token, pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null };
  } catch {
    return { token: '', pid: null };
  }
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function releaseOwnedLock(lockPath, lockFd, lockToken) {
  try { fs.closeSync(lockFd); } catch {}
  try {
    if (readManifestLockOwner(lockPath).token === lockToken) fs.unlinkSync(lockPath);
  } catch {}
}

function sameFile(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function removeUnchangedLockFile(lockPath, observedStat, observedOwner) {
  try {
    const currentStat = fs.statSync(lockPath);
    const currentOwner = readManifestLockOwner(lockPath);
    if (
      !sameFile(currentStat, observedStat)
      || (observedOwner && currentOwner.token !== observedOwner.token)
    ) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function createOwnedLockFile(lockPath, lockToken) {
  let lockFd = null;
  let createdStat = null;
  try {
    lockFd = fs.openSync(lockPath, 'wx', 0o600);
    createdStat = fs.fstatSync(lockFd);
    fs.writeFileSync(lockFd, `${lockToken}\n`, 'utf8');
    return lockFd;
  } catch (error) {
    if (lockFd != null) {
      try { fs.closeSync(lockFd); } catch {}
      removeUnchangedLockFile(lockPath, createdStat, null);
    }
    throw error;
  }
}

function lockIdentity(owner, stat) {
  return owner.token || `empty:${stat.dev}:${stat.ino}:${stat.mtimeMs}`;
}

function acquireReclaimGuard(reclaimPath, reclaimToken) {
  for (let attempt = 0; attempt < MANIFEST_RECLAIM_GUARD_ATTEMPTS; attempt += 1) {
    try {
      return createOwnedLockFile(reclaimPath, reclaimToken);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(reclaimPath);
        const owner = readManifestLockOwner(reclaimPath);
        if (
          Date.now() - stat.mtimeMs > MANIFEST_LOCK_STALE_MS
          && !isProcessAlive(owner.pid)
          && removeUnchangedLockFile(reclaimPath, stat, owner)
        ) {
          continue;
        }
      } catch {}
      return null;
    }
  }
  return null;
}

function reclaimStaleManifestLock(lockPath, observedOwner, observedStat) {
  if (
    Date.now() - observedStat.mtimeMs <= MANIFEST_LOCK_STALE_MS
    || isProcessAlive(observedOwner.pid)
  ) {
    return false;
  }

  const observedIdentity = lockIdentity(observedOwner, observedStat);
  const ownerHash = crypto.createHash('sha1').update(observedIdentity).digest('hex').slice(0, 12);
  const reclaimPath = `${lockPath}.reclaim-${ownerHash}`;
  const reclaimToken = `${process.pid}:${crypto.randomBytes(12).toString('hex')}`;
  let reclaimFd = null;
  try {
    reclaimFd = acquireReclaimGuard(reclaimPath, reclaimToken);
    if (reclaimFd == null) return false;

    const currentStat = fs.statSync(lockPath);
    const currentOwner = readManifestLockOwner(lockPath);
    if (
      lockIdentity(currentOwner, currentStat) !== observedIdentity
      || Date.now() - currentStat.mtimeMs <= MANIFEST_LOCK_STALE_MS
      || isProcessAlive(currentOwner.pid)
    ) {
      return false;
    }
    return removeUnchangedLockFile(lockPath, currentStat, currentOwner);
  } catch (error) {
    if (error?.code === 'EEXIST' || error?.code === 'ENOENT') return false;
    throw error;
  } finally {
    if (reclaimFd != null) releaseOwnedLock(reclaimPath, reclaimFd, reclaimToken);
  }
}

function tryAcquireManifestLock(lockPath, lockToken) {
  try {
    return createOwnedLockFile(lockPath, lockToken);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    try {
      const stat = fs.statSync(lockPath);
      const owner = readManifestLockOwner(lockPath);
      reclaimStaleManifestLock(lockPath, owner, stat);
    } catch {}
    return null;
  }
}

function withManifestLock(autoDevDir, operation) {
  ensureDir(autoDevDir);
  const lockPath = path.join(autoDevDir, `${MANIFEST_FILE_NAME}.lock`);
  const lockToken = `${process.pid}:${crypto.randomBytes(12).toString('hex')}`;
  let lockFd = null;
  const deadline = Date.now() + MANIFEST_LOCK_WAIT_MS;
  while (lockFd == null && Date.now() < deadline) {
    lockFd = tryAcquireManifestLock(lockPath, lockToken);
    if (lockFd == null) sleepSync(Math.min(MANIFEST_LOCK_RETRY_MS, Math.max(1, deadline - Date.now())));
  }
  if (lockFd == null) throw new Error('auto_dev_manifest_lock_timeout');

  try {
    return operation();
  } finally {
    releaseOwnedLock(lockPath, lockFd, lockToken);
  }
}

async function withManifestLockAsync(autoDevDir, operation) {
  ensureDir(autoDevDir);
  const lockPath = path.join(autoDevDir, `${MANIFEST_FILE_NAME}.lock`);
  const lockToken = `${process.pid}:${crypto.randomBytes(12).toString('hex')}`;
  let lockFd = null;
  const deadline = Date.now() + MANIFEST_LOCK_WAIT_MS;
  while (lockFd == null && Date.now() < deadline) {
    lockFd = tryAcquireManifestLock(lockPath, lockToken);
    if (lockFd == null) await sleep(Math.min(MANIFEST_LOCK_RETRY_MS, Math.max(1, deadline - Date.now())));
  }
  if (lockFd == null) throw new Error('auto_dev_manifest_lock_timeout');

  try {
    return await operation();
  } finally {
    releaseOwnedLock(lockPath, lockFd, lockToken);
  }
}

function writeAutoDevManifestAtomic(autoDevDir, manifest) {
  ensureDir(autoDevDir);
  const manifestPath = manifestPathForDir(autoDevDir);
  const next = {
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: manifest?.entries && typeof manifest.entries === 'object' ? manifest.entries : {},
  };
  const tempPath = `${manifestPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let tempFd = null;
  try {
    tempFd = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(tempFd, JSON.stringify(next, null, 2), 'utf8');
    fs.fsyncSync(tempFd);
    fs.closeSync(tempFd);
    tempFd = null;
    fs.renameSync(tempPath, manifestPath);
  } finally {
    if (tempFd != null) {
      try { fs.closeSync(tempFd); } catch {}
    }
    try { fs.unlinkSync(tempPath); } catch {}
  }
  return manifestPath;
}

function saveAutoDevManifest(autoDevDir, manifest) {
  return withManifestLock(autoDevDir, () => writeAutoDevManifestAtomic(autoDevDir, manifest));
}

function upsertAutoDevManifestEntryUnlocked(autoDevDir, relPath, patch = {}) {
  const normalized = normalizeRelPath(relPath);
  if (!normalized) return null;
  const manifest = loadAutoDevManifest(autoDevDir);
  const current = manifest.entries[normalized] || {};
  if (hasCompletedManifestRecord(current) && isActiveAutoDevState(patch.state)) {
    const currentHash = manifestContentHash(current);
    const nextHash = String(patch.contentHash || '').trim();
    if (!nextHash || (currentHash && currentHash === nextHash)) return current;
    manifest.entries[normalized] = {
      ...resetTerminalManifestEntry(current, nextHash, 'regenerated_content'),
      ...patch,
      relPath: normalized,
    };
    writeAutoDevManifestAtomic(autoDevDir, manifest);
    return manifest.entries[normalized];
  }
  manifest.entries[normalized] = {
    state: 'inbox',
    createdAt: current.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...current,
    ...patch,
    relPath: normalized,
  };
  writeAutoDevManifestAtomic(autoDevDir, manifest);
  return manifest.entries[normalized];
}

function upsertAutoDevManifestEntry(autoDevDir, relPath, patch = {}) {
  return withManifestLock(autoDevDir, () => upsertAutoDevManifestEntryUnlocked(autoDevDir, relPath, patch));
}

async function upsertAutoDevManifestEntryAsync(autoDevDir, relPath, patch = {}) {
  return withManifestLockAsync(autoDevDir, () => upsertAutoDevManifestEntryUnlocked(autoDevDir, relPath, patch));
}

function markAutoDevManifestState(autoDevDir, relPath, state, patch = {}) {
  return upsertAutoDevManifestEntry(autoDevDir, relPath, { state, ...patch });
}

function patchAutoDevManifestEntryIfMatches(autoDevDir, relPath, expected = {}, patch = {}) {
  const normalized = normalizeRelPath(relPath);
  if (!normalized) return { updated: false, reason: 'invalid_rel_path', entry: null };
  return withManifestLock(autoDevDir, () => {
    const manifest = loadAutoDevManifest(autoDevDir);
    const current = manifest.entries[normalized];
    if (!current || typeof current !== 'object') {
      return { updated: false, reason: 'entry_missing', entry: null };
    }

    const expectedHash = String(expected.contentHash || '').trim();
    if (expectedHash && manifestContentHash(current) !== expectedHash) {
      return { updated: false, reason: 'content_hash_mismatch', entry: current };
    }
    const expectedAlarmEventId = String(expected.alarmEventId || '').trim();
    if (
      expectedAlarmEventId
      && String(current.callbackPayload?.alarmEventId || '').trim() !== expectedAlarmEventId
    ) {
      return { updated: false, reason: 'alarm_event_id_mismatch', entry: current };
    }
    if (
      Object.prototype.hasOwnProperty.call(expected, 'callbackState')
      && String(current.callbackState || '') !== String(expected.callbackState || '')
    ) {
      return { updated: false, reason: 'callback_state_mismatch', entry: current };
    }

    manifest.entries[normalized] = {
      ...current,
      ...patch,
      relPath: normalized,
      updatedAt: new Date().toISOString(),
    };
    writeAutoDevManifestAtomic(autoDevDir, manifest);
    return { updated: true, reason: null, entry: manifest.entries[normalized] };
  });
}

function syncAutoDevManifestUnlocked(autoDevDir, options = {}) {
  ensureDir(autoDevDir);
  const manifest = loadAutoDevManifest(autoDevDir);
  const names = fs.readdirSync(autoDevDir).filter(isAutoDevInboxMarkdown);
  const completedRelPaths = loadCompletedAutoDevRelPaths(options);

  for (const name of names) {
    const abs = path.join(autoDevDir, name);
    let stat = null;
    try { stat = fs.statSync(abs); } catch {}
    if (!stat?.isFile()) continue;
    const relPath = normalizeRelPath(path.relative(getProjectRoot(), abs));
    const current = manifest.entries[relPath];
    if (!current) {
      manifest.entries[relPath] = {
        relPath,
        state: 'inbox',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        source: 'root_scan',
      };
      continue;
    }
    const currentContentHash = hashAutoDevContent(fs.readFileSync(abs, 'utf8'));
    const recordedContentHash = manifestContentHash(current);
    const terminalRecord = hasCompletedManifestRecord(current)
      || ['archived', 'archived_missing', 'dead_letter'].includes(String(current.state || ''));
    if (
      terminalRecord
      && recordedContentHash
      && recordedContentHash !== currentContentHash
    ) {
      manifest.entries[relPath] = {
        ...resetTerminalManifestEntry(current, currentContentHash, 'regenerated_content'),
        relPath,
      };
      continue;
    }
    if (terminalRecord && !current.contentHash && recordedContentHash === currentContentHash) {
      manifest.entries[relPath] = {
        ...current,
        contentHash: currentContentHash,
        updatedAt: new Date().toISOString(),
      };
    }
    if (!current.state || current.state === 'archived_missing') {
      if (current.state === 'archived_missing' && hasCompletedAutoDevHistory(relPath, current, completedRelPaths)) {
        manifest.entries[relPath] = {
          ...current,
          state: 'archived_missing',
          updatedAt: new Date().toISOString(),
          source: 'completed_no_requeue',
          completedNoRequeueAt: new Date().toISOString(),
        };
        continue;
      }
      manifest.entries[relPath] = {
        ...current,
        state: 'inbox',
        updatedAt: new Date().toISOString(),
        source: current.source || 'root_scan',
      };
    }
  }

  for (const [relPath, entry] of Object.entries(manifest.entries || {})) {
    if (!entry || typeof entry !== 'object') continue;
    const abs = path.join(getProjectRoot(), relPath);
    const archivedPath = normalizeRelPath(entry.archivedPath || '');
    const archivedAbs = archivedPath ? path.join(getProjectRoot(), archivedPath) : null;
    const hasArchivedRecord = Boolean(entry.archivedAt || archivedPath || entry.reason);
    if (!hasArchivedRecord) continue;

    if (fs.existsSync(abs)) {
      if (archivedAbs && fs.existsSync(archivedAbs)) {
        // archivedPath 파일이 실제로 존재 → 정상 완료, archived 유지
        manifest.entries[relPath] = {
          ...entry,
          state: 'archived',
          updatedAt: new Date().toISOString(),
        };
      } else {
        if (hasCompletedAutoDevHistory(relPath, entry, completedRelPaths)) {
          manifest.entries[relPath] = {
            ...entry,
            state: 'archived_missing',
            updatedAt: new Date().toISOString(),
            source: 'completed_no_requeue',
            completedNoRequeueAt: new Date().toISOString(),
          };
          continue;
        }
        // archivedPath 소실 또는 없음 = Hub 재생성/루트 잔존 케이스 → inbox 재진입
        const { archivedAt, archivedBy, archivedPath: _ap, reason, note, resolvedReason, ...rest } = entry;
        manifest.entries[relPath] = {
          ...rest,
          state: 'inbox',
          updatedAt: new Date().toISOString(),
          source: 'requeued_missing_archive',
        };
      }
      continue;
    }

    manifest.entries[relPath] = {
      ...entry,
      state: archivedAbs && fs.existsSync(archivedAbs) ? 'archived' : 'archived_missing',
      updatedAt: new Date().toISOString(),
    };
  }

  for (const [relPath, entry] of Object.entries(manifest.entries || {})) {
    if (!entry?.state || !['inbox', 'claimed', 'active', 'failed'].includes(String(entry.state))) continue;
    const abs = path.join(getProjectRoot(), relPath);
    if (!fs.existsSync(abs)) {
      manifest.entries[relPath] = {
        ...entry,
        state: 'archived_missing',
        updatedAt: new Date().toISOString(),
      };
    }
  }

  writeAutoDevManifestAtomic(autoDevDir, manifest);
  return manifest;
}

function syncAutoDevManifest(autoDevDir, options = {}) {
  return withManifestLock(autoDevDir, () => syncAutoDevManifestUnlocked(autoDevDir, options));
}

function listAutoDevManifestEntries(autoDevDir, allowedStates = ['inbox'], options = {}) {
  const manifest = syncAutoDevManifest(autoDevDir, options);
  const allowed = new Set((allowedStates || []).map((item) => String(item)));
  return Object.values(manifest.entries || {})
    .filter((entry) => entry?.relPath && isAutoDevInboxMarkdown(path.basename(String(entry.relPath || ''))))
    .filter((entry) => allowed.has(String(entry.state || '')))
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
    .map((entry) => entry.relPath);
}

module.exports = {
  MANIFEST_FILE_NAME,
  AUTO_DEV_FILE_PREFIXES,
  isAutoDevInboxMarkdown,
  loadCompletedAutoDevRelPaths,
  hasCompletedAutoDevHistory,
  manifestPathForDir,
  loadAutoDevManifest,
  saveAutoDevManifest,
  upsertAutoDevManifestEntry,
  upsertAutoDevManifestEntryAsync,
  markAutoDevManifestState,
  patchAutoDevManifestEntryIfMatches,
  syncAutoDevManifest,
  listAutoDevManifestEntries,
  _testOnly_withManifestLock: withManifestLock,
  _testOnly_withManifestLockAsync: withManifestLockAsync,
};
