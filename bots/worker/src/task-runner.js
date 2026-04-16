'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('node:path');
const { createProcessSingleton } = require('../lib/process-singleton');

const runtimePath = path.join(__dirname, '../../../dist/ts-runtime/bots/worker/src/task-runner.js');
const legacyPath = path.join(__dirname, 'task-runner.legacy.js');
const singleton = createProcessSingleton('ai-agent-system-worker-task-runner');

function isRuntimeLoadFailure(error) {
  if (!error) return false;
  if (error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_REQUIRE_ESM') return true;
  const message = String(error.message || '');
  return (
    message.includes(runtimePath) ||
    message.includes('/dist/ts-runtime/') ||
    message.includes('/packages/core/lib/agent-memory') ||
    message.includes('ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX')
  );
}

function selectTargetPath() {
  if (fs.existsSync(runtimePath)) {
    try {
      require(runtimePath);
      return runtimePath;
    } catch (error) {
      if (!isRuntimeLoadFailure(error)) throw error;
      console.warn(`[worker-task-runner] runtime 진입 실패 — legacy로 폴백: ${error.message}`);
    }
  }
  return legacyPath;
}

if (require.main === module) {
  const lock = singleton.acquire();
  if (!lock.acquired) {
    console.warn(`[worker-task-runner] 이미 실행 중인 인스턴스 감지 (PID: ${lock.existingPid})`);
    process.exit(0);
  }

  const targetPath = selectTargetPath();
  const child = spawn(process.execPath, [targetPath], {
    cwd: __dirname,
    env: process.env,
    stdio: 'inherit',
  });

  const forwardSignal = (signal) => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  };

  process.on('SIGINT', () => forwardSignal('SIGINT'));
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));

  child.on('exit', (code, signal) => {
    singleton.cleanup();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

try {
  module.exports = require(runtimePath);
} catch (error) {
  if (!isRuntimeLoadFailure(error)) throw error;
  module.exports = require(legacyPath);
}
