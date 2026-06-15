'use strict';

const fs = require('fs');
const path = require('path');
const pipeline = require('../auto-dev-pipeline');
const {
  loadAutoDevManifest,
} = require('../../../../packages/core/lib/auto-dev-manifest.ts');

const ACTIVE_STATES = new Set(['inbox', 'claimed', 'active']);

/**
 * @param {any} items
 * @param {any} selector
 */
function countBy(items = [], selector = JSON.stringify) {
  const counts = new Map();
  for (const item of items || []) {
    const key = selector(item) || 'unknown';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Object.fromEntries(counts.entries());
}

/**
 * @param {any} root
 * @param {any} relPath
 */
function pathExists(root = '', relPath = '') {
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
  /** @type {any[]} */
  const entries = JSON.parse(JSON.stringify(Object.values(manifest.entries || {})));
  const active = [];
  for (const entry of entries || []) {
    if (ACTIVE_STATES.has(String(entry.state || ''))) active.push(entry);
  }
  const missingActive = [];
  for (const entry of active || []) {
    if (!pathExists(root, entry.relPath)) missingActive.push(entry);
  }
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
  /** @type {any[]} */
  const jobs = JSON.parse(JSON.stringify(Object.values(state.jobs || {})));
  const missing = [];
  for (const job of jobs || []) {
    if (/ENOENT|no such file/i.test(String(job.error || job.lastError || ''))) missing.push(job);
  }
  const historical = [];
  for (const job of jobs || []) {
    if (['failed', 'blocked', 'completed'].includes(String(job.status || ''))) historical.push(job);
  }
  const activeMissing = [];
  for (const job of missing || []) {
    if (!['failed', 'blocked', 'completed'].includes(String(job.status || ''))) activeMissing.push(job);
  }
  const historicalMissing = [];
  for (const job of missing || []) {
    if (['failed', 'blocked', 'completed'].includes(String(job.status || ''))) historicalMissing.push(job);
  }
  return {
    updatedAt: state.updatedAt || null,
    total: jobs.length,
    states: countBy(jobs, (job) => job.status),
    stages: countBy(jobs, (job) => job.stage),
    historicalStateCount: historical.length,
    missingJobCount: missing.length,
    activeMissingJobCount: activeMissing.length,
    historicalMissingJobCount: historicalMissing.length,
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
