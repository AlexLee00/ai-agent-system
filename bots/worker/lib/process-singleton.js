'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

function createProcessSingleton(lockName) {
  const lockPath = path.join(os.tmpdir(), `${lockName}.pid`);

  function readExistingPid() {
    try {
      const raw = fs.readFileSync(lockPath, 'utf8').trim();
      const pid = Number.parseInt(raw, 10);
      return Number.isInteger(pid) ? pid : null;
    } catch (_error) {
      return null;
    }
  }

  function cleanup() {
    try {
      const current = readExistingPid();
      if (current === process.pid) {
        fs.unlinkSync(lockPath);
      }
    } catch (_error) {
      // Best-effort cleanup only.
    }
  }

  function acquire() {
    const existingPid = readExistingPid();
    if (existingPid && existingPid !== process.pid && pidIsAlive(existingPid)) {
      return { acquired: false, existingPid, lockPath };
    }

    fs.writeFileSync(lockPath, `${process.pid}\n`, 'utf8');
    process.on('exit', cleanup);
    process.on('SIGINT', () => {
      cleanup();
      process.exit(130);
    });
    process.on('SIGTERM', () => {
      cleanup();
      process.exit(143);
    });

    return { acquired: true, lockPath };
  }

  return { acquire, cleanup, lockPath };
}

module.exports = { createProcessSingleton };
