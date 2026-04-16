'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createProcessSingleton } = require('../lib/process-singleton');

const runtimePath = path.join(__dirname, '../../../dist/ts-runtime/bots/worker/src/worker-lead.js');
const legacyPath = path.join(__dirname, 'worker-lead.legacy.js');
const singleton = createProcessSingleton('ai-agent-system-worker-lead');

function isRuntimeLoadFailure(error) {
  if (!error) return false;
  if (error.code === 'MODULE_NOT_FOUND') return true;
  const message = String(error.message || '');
  return (
    message.includes(runtimePath) ||
    message.includes('/dist/ts-runtime/') ||
    message.includes('./secrets.legacy.js')
  );
}

function selectTargetPath() {
  if (fs.existsSync(runtimePath)) {
    try {
      require(runtimePath);
      return runtimePath;
    } catch (error) {
      if (!isRuntimeLoadFailure(error)) throw error;
      console.warn(`[worker-lead] runtime 진입 실패 — legacy로 폴백: ${error.message}`);
    }
  }
  return legacyPath;
}

if (require.main === module) {
  const lock = singleton.acquire();
  if (!lock.acquired) {
    console.warn(`[worker-lead] 이미 실행 중인 인스턴스 감지 (PID: ${lock.existingPid})`);
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
