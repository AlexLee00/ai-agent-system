// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const pipeline = require('../auto-dev-pipeline');
const {
  loadAutoDevManifest,
} = require('../../../../packages/core/lib/auto-dev-manifest.ts');

const ACTIVE_STATES = new Set(['inbox', 'claimed', 'active']);

function countBy(items, selector) {
  const counts = {};
  for (const item of items || []) {
    const key = selector(item) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function pathExists(root, relPath) {
  try {
    return fs.existsSync(path.join(root, relPath));
  } catch {
    return false;
  }
}

function summarizeManifest({
  autoDevDir = pipeline.AUTO_DEV_DIR,
  root = path.resolve(autoDevDir, '..', '..'),
} = {}) {
  const manifest = loadAutoDevManifest(autoDevDir);
  const entries = Object.values(manifest.entries || {});
  const active = entries.filter((entry) => ACTIVE_STATES.has(String(entry.state || '')));
  const missingActive = active.filter((entry) => !pathExists(root, entry.relPath));
  return {
    updatedAt: manifest.updatedAt || null,
    total: entries.length,
    states: countBy(entries, (entry) => entry.state),
    activeCount: active.length,
    missingActiveCount: missingActive.length,
    missingActive: missingActive.slice(0, 20).map((entry) => ({
      relPath: entry.relPath,
      state: entry.state,
      reason: entry.reason || null,
    })),
  };
}

function summarizeRuntimeState({
  state = pipeline.loadState(),
} = {}) {
  const jobs = Object.values(state.jobs || {});
  const missing = jobs.filter((job) => /ENOENT|no such file/i.test(String(job.error || job.lastError || '')));
  const historical = jobs.filter((job) => ['failed', 'blocked', 'completed'].includes(String(job.status || '')));
  return {
    updatedAt: state.updatedAt || null,
    total: jobs.length,
    states: countBy(jobs, (job) => job.status),
    stages: countBy(jobs, (job) => job.stage),
    historicalStateCount: historical.length,
    missingJobCount: missing.length,
    missingJobs: missing.slice(-20).map((job) => ({
      id: job.id || null,
      relPath: job.relPath || null,
      status: job.status || null,
      stage: job.stage || null,
      updatedAt: job.updatedAt || null,
      error: String(job.error || job.lastError || '').slice(0, 240),
    })),
  };
}

module.exports = {
  ACTIVE_STATES,
  summarizeManifest,
  summarizeRuntimeState,
};
