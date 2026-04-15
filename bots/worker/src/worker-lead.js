'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const runtimePath = path.join(__dirname, '../../../dist/ts-runtime/bots/worker/src/worker-lead.js');
const legacyPath = path.join(__dirname, 'worker-lead.legacy.js');

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
