// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('./env');

const MANIFEST_FILE_NAME = '.auto-dev-manifest.json';
const AUTO_DEV_FILE_PREFIXES = ['ALARM_INCIDENT_', 'CODEX_', 'PATCH_REQUEST'];

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

function saveAutoDevManifest(autoDevDir, manifest) {
  ensureDir(autoDevDir);
  const manifestPath = manifestPathForDir(autoDevDir);
  const next = {
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: manifest?.entries && typeof manifest.entries === 'object' ? manifest.entries : {},
  };
  fs.writeFileSync(manifestPath, JSON.stringify(next, null, 2), 'utf8');
  return manifestPath;
}

function upsertAutoDevManifestEntry(autoDevDir, relPath, patch = {}) {
  const normalized = normalizeRelPath(relPath);
  if (!normalized) return null;
  const manifest = loadAutoDevManifest(autoDevDir);
  const current = manifest.entries[normalized] || {};
  if (hasCompletedManifestRecord(current) && isActiveAutoDevState(patch.state)) {
    return current;
  }
  manifest.entries[normalized] = {
    state: 'inbox',
    createdAt: current.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...current,
    ...patch,
    relPath: normalized,
  };
  saveAutoDevManifest(autoDevDir, manifest);
  return manifest.entries[normalized];
}

function markAutoDevManifestState(autoDevDir, relPath, state, patch = {}) {
  return upsertAutoDevManifestEntry(autoDevDir, relPath, { state, ...patch });
}

function syncAutoDevManifest(autoDevDir, options = {}) {
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

  saveAutoDevManifest(autoDevDir, manifest);
  return manifest;
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
  markAutoDevManifestState,
  syncAutoDevManifest,
  listAutoDevManifestEntries,
};
