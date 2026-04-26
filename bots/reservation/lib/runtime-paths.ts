'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function getAiAgentHome() {
  return process.env.AI_AGENT_HOME
    || process.env.JAY_HOME
    || path.join(os.homedir(), '.ai-agent-system');
}

function getAiAgentWorkspace() {
  return process.env.AI_AGENT_WORKSPACE
    || process.env.JAY_WORKSPACE
    || path.join(getAiAgentHome(), 'workspace');
}

function getReservationRuntimeDir() {
  return process.env.RESERVATION_RUNTIME_DIR
    || process.env.SKA_RUNTIME_DIR
    || path.join(getAiAgentWorkspace(), 'reservation');
}

function getReservationRuntimeFile(filename) {
  return path.join(getReservationRuntimeDir(), filename);
}

function getReadableReservationRuntimeFile(filename) {
  return getReservationRuntimeFile(filename);
}

function getReservationBrowserProfileRoot() {
  return process.env.NAVER_BROWSER_PROFILE_ROOT
    || path.join(getReservationRuntimeDir(), 'browser-profiles');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return filePath;
}

module.exports = {
  getAiAgentHome,
  getAiAgentWorkspace,
  getReservationRuntimeDir,
  getReservationRuntimeFile,
  getReadableReservationRuntimeFile,
  getReservationBrowserProfileRoot,
  ensureDir,
  ensureParentDir,
};
