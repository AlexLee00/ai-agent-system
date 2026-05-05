// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('./env');

const MANIFEST_FILE_NAME = '.auto-dev-manifest.json';
const INCIDENT_FILE_PREFIX = 'ALARM_INCIDENT_';

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
  manifest.entries[normalized] = {
    relPath: normalized,
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

function syncAutoDevManifest(autoDevDir) {
  ensureDir(autoDevDir);
  const manifest = loadAutoDevManifest(autoDevDir);
  const names = fs.readdirSync(autoDevDir)
    .filter((name) => name.endsWith('.md'))
    .filter((name) => name.startsWith(INCIDENT_FILE_PREFIX))
    .filter((name) => !name.startsWith('.'));

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
      manifest.entries[relPath] = {
        ...entry,
        state: 'archived',
        updatedAt: new Date().toISOString(),
      };
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

function listAutoDevManifestEntries(autoDevDir, allowedStates = ['inbox']) {
  const manifest = syncAutoDevManifest(autoDevDir);
  const allowed = new Set((allowedStates || []).map((item) => String(item)));
  return Object.values(manifest.entries || {})
    .filter((entry) => entry?.relPath && path.basename(String(entry.relPath || '')).startsWith(INCIDENT_FILE_PREFIX))
    .filter((entry) => allowed.has(String(entry.state || '')))
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
    .map((entry) => entry.relPath);
}

module.exports = {
  MANIFEST_FILE_NAME,
  manifestPathForDir,
  loadAutoDevManifest,
  saveAutoDevManifest,
  upsertAutoDevManifestEntry,
  markAutoDevManifestState,
  syncAutoDevManifest,
  listAutoDevManifestEntries,
};
