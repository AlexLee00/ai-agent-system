#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const { runCommentReply } = require('../lib/commenter.ts');

const LOCK_DIR = path.join(env.PROJECT_ROOT, 'tmp');
const LOCK_FILE = path.join(LOCK_DIR, 'blog-commenter.lock');

function ensureLockDir() {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
}

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  ensureLockDir();
  const staleMs = 15 * 60 * 1000;
  const existing = readLock();
  if (existing?.pid && isPidAlive(existing.pid)) {
    return { acquired: false, lock: existing };
  }
  if (existing?.startedAt && Date.now() - Number(existing.startedAt) < staleMs) {
    return { acquired: false, lock: existing };
  }
  const lock = { pid: process.pid, startedAt: Date.now() };
  fs.writeFileSync(LOCK_FILE, JSON.stringify(lock), 'utf8');
  return { acquired: true, lock };
}

function releaseLock() {
  const existing = readLock();
  if (!existing || existing.pid === process.pid) {
    try {
      fs.unlinkSync(LOCK_FILE);
    } catch {}
  }
}

async function main() {
  const testMode = process.env.BLOG_COMMENTER_TEST === 'true';
  const lockState = acquireLock();
  if (!lockState.acquired) {
    console.log(`[커멘터] 스킵: already_running pid=${lockState.lock?.pid || 'unknown'}`);
    return;
  }
  env.printModeBanner('blog commenter');
  try {
    const result = await runCommentReply({ testMode });
    if (result?.ok !== true && result?.skipped === true) {
      console.log(`[커멘터] 스킵: ${result.reason}`);
      return;
    }

    console.log(`detected=${result.detected} pending=${result.pending} replied=${result.replied} failed=${result.failed} skipped=${result.skipped}`);
  } finally {
    releaseLock();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[커멘터] 실패:', error?.stack || error?.message || String(error));
    process.exit(1);
  });
