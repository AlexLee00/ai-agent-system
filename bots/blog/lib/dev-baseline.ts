'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');

const BLOG_ROOT = path.join(env.PROJECT_ROOT, 'bots', 'blog');
const DEV_BASELINE_DIR = path.join(BLOG_ROOT, 'output', 'ops');
const DEV_BASELINE_PATH = path.join(DEV_BASELINE_DIR, 'dev-baseline.json');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readDevelopmentBaseline() {
  try {
    if (!fs.existsSync(DEV_BASELINE_PATH)) return null;
    const payload = JSON.parse(fs.readFileSync(DEV_BASELINE_PATH, 'utf8'));
    const startedAtIso = String(payload?.startedAt || '').trim();
    if (!startedAtIso) return null;
    const startedAt = new Date(startedAtIso);
    if (Number.isNaN(startedAt.getTime())) return null;
    return {
      active: true,
      startedAtIso,
      startedAt,
      source: String(payload?.source || 'manual'),
      note: String(payload?.note || ''),
      path: DEV_BASELINE_PATH,
    };
  } catch {
    return null;
  }
}

function writeDevelopmentBaseline({
  startedAt = new Date(),
  source = 'manual',
  note = '',
} = {}) {
  ensureDir(DEV_BASELINE_DIR);
  const iso = new Date(startedAt).toISOString();
  const payload = {
    startedAt: iso,
    source: String(source || 'manual'),
    note: String(note || ''),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(DEV_BASELINE_PATH, JSON.stringify(payload, null, 2), 'utf8');
  return {
    active: true,
    startedAtIso: iso,
    startedAt: new Date(iso),
    source: payload.source,
    note: payload.note,
    path: DEV_BASELINE_PATH,
  };
}

function buildSinceClause(columnName = '', baseline = null) {
  const column = String(columnName || '').trim();
  if (!column || !baseline?.startedAtIso) return '';
  const iso = String(baseline.startedAtIso).replace(/'/g, "''");
  return `\n        AND ${column} >= '${iso}'::timestamptz`;
}

module.exports = {
  DEV_BASELINE_PATH,
  readDevelopmentBaseline,
  writeDevelopmentBaseline,
  buildSinceClause,
};
