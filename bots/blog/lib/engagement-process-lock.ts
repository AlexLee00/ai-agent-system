// @ts-nocheck
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const env = require('../../../packages/core/lib/env');

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function tryAcquire(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    const lock = { pid: process.pid, startedAt: Date.now(), path: lockPath };
    fs.writeFileSync(fd, JSON.stringify(lock), 'utf8');
    fs.closeSync(fd);
    return { acquired: true, lock };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    return { acquired: false, lock: readLock(lockPath) };
  }
}

async function acquireEngagementLock(options = {}) {
  const lockPath = options.lockPath || path.join(env.PROJECT_ROOT, 'tmp', 'blog-engagement.lock');
  const maxWaitMs = Math.max(0, Number(options.maxWaitMs ?? 5 * 60 * 1000));
  const pollMs = Math.max(25, Number(options.pollMs ?? 1000));
  const deadline = Date.now() + maxWaitMs;

  while (true) {
    const attempt = tryAcquire(lockPath);
    if (attempt.acquired) return attempt;
    if (!isPidAlive(Number(attempt.lock?.pid || 0))) {
      try { fs.unlinkSync(lockPath); } catch {}
      continue;
    }
    if (Date.now() >= deadline) return { acquired: false, lock: attempt.lock, reason: 'already_running' };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function releaseEngagementLock(lock) {
  const lockPath = String(lock?.path || '');
  if (!lockPath) return;
  const current = readLock(lockPath);
  if (Number(current?.pid || 0) !== process.pid) return;
  try { fs.unlinkSync(lockPath); } catch {}
}

module.exports = {
  acquireEngagementLock,
  releaseEngagementLock,
  isPidAlive,
};
