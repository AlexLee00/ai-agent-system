// @ts-nocheck
'use strict';

const os = require('os');
const { execSync } = require('child_process');
const env = require('../../../../packages/core/lib/env');

function safeExec(command) {
  try {
    return execSync(command, {
      cwd: env.PROJECT_ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
  } catch (error) {
    console.warn(`[steward/env-sync] 명령 실패: ${error.message}`);
    return '';
  }
}

function getLocalHead() {
  return safeExec('git rev-parse HEAD');
}

function getRemoteHead() {
  safeExec('git fetch origin main --quiet');
  return safeExec('git rev-parse origin/main') || null;
}

function checkSync() {
  const local = getLocalHead();
  const remote = getRemoteHead();
  if (!local || !remote) {
    return { synced: null, reason: 'git head 조회 실패', hostname: os.hostname() };
  }

  const behind = Number.parseInt(safeExec('git rev-list --count HEAD..origin/main') || '0', 10);
  const ahead = Number.parseInt(safeExec('git rev-list --count origin/main..HEAD') || '0', 10);

  return {
    synced: behind === 0 && ahead === 0,
    local: local.slice(0, 8),
    remote: remote.slice(0, 8),
    behind,
    ahead,
    hostname: os.hostname(),
  };
}

module.exports = {
  checkSync,
  getLocalHead,
  getRemoteHead,
};
