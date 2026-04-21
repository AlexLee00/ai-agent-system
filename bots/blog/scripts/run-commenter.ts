#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const { runCommentReply } = require('../lib/commenter.ts');
const { writeCommenterRunResult } = require('../lib/commenter-run-telemetry.ts');

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
  const argv = process.argv.slice(2);
  const testMode = process.env.BLOG_COMMENTER_TEST === 'true' || argv.includes('--test-mode');
  const lockState = acquireLock();
  if (!lockState.acquired) {
    console.log(`[커멘터] 스킵: already_running pid=${lockState.lock?.pid || 'unknown'}`);
    return;
  }
  env.printModeBanner('blog commenter');
  try {
    const result = await runCommentReply({ testMode });
    writeCommenterRunResult({
      executedAt: new Date().toISOString(),
      testMode,
      ok: Boolean(result?.ok),
      skipped: Boolean(result?.skipped),
      reason: String(result?.reason || ''),
      detected: Number(result?.detected || 0),
      pending: Number(result?.pending || 0),
      replied: Number(result?.replied || 0),
      failed: Number(result?.failed || 0),
      skippedCount: Number(result?.skipped || 0),
    });
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
    writeCommenterRunResult({
      executedAt: new Date().toISOString(),
      testMode: process.env.BLOG_COMMENTER_TEST === 'true',
      ok: false,
      skipped: false,
      reason: String(error?.message || error || ''),
      detected: 0,
      pending: 0,
      replied: 0,
      failed: 1,
      skippedCount: 0,
    });
    console.error('[커멘터] 실패:', error?.stack || error?.message || String(error));
    process.exit(1);
  });
