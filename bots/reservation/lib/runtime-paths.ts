'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function getAiAgentHome() {
  return process.env.AI_AGENT_HOME
    || process.env.JAY_HOME
    || path.join(os.homedir(), '.ai-agent-system');
}

function getProjectRoot() {
  return process.env.PROJECT_ROOT || '/Users/alexlee/projects/ai-agent-system';
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

function normalizeReservationRelPath(relPath) {
  if (!relPath || path.isAbsolute(relPath)) return relPath;
  if (relPath.startsWith('bots/reservation/')) return relPath;
  if (/^(auto|lib|manual|scripts|src)\//.test(relPath)) return path.join('bots/reservation', relPath);
  return relPath;
}

function resolveReservationManualScript({
  label,
  sourceRelPath,
  jsRelPath,
  projectRoot = getProjectRoot(),
  runtimeMode = process.env.MODE,
}) {
  const daemonPath = label ? path.join(projectRoot, 'dist', 'daemons', `${label}.cjs`) : null;
  if (daemonPath && fs.existsSync(daemonPath)) return daemonPath;
  if (label && runtimeMode === 'ops') {
    throw new Error(`missing prebuilt reservation daemon in OPS: ${label} (${daemonPath})`);
  }

  const normalizedJsRelPath = normalizeReservationRelPath(jsRelPath);
  const jsPath = normalizedJsRelPath ? path.join(projectRoot, normalizedJsRelPath) : null;
  if (jsPath && fs.existsSync(jsPath)) return jsPath;

  const normalizedSourceRelPath = normalizeReservationRelPath(sourceRelPath);
  const sourcePath = path.join(projectRoot, normalizedSourceRelPath);
  return sourcePath;
}

function resolveReservationChildRuntime({
  label,
  sourceRelPath,
  jsRelPath = String(sourceRelPath || '').replace(/\.ts$/, '.js'),
  projectRoot = getProjectRoot(),
  runtimeMode = process.env.MODE,
  nodeBin = process.execPath || '/opt/homebrew/bin/node',
  tsxBin = path.join(projectRoot, 'node_modules/.bin/tsx'),
}) {
  const script = resolveReservationManualScript({
    label,
    sourceRelPath,
    jsRelPath,
    projectRoot,
    runtimeMode,
  });
  const command = /\.(?:cjs|mjs|js)$/u.test(script) ? nodeBin : tsxBin;
  return { command, script };
}

module.exports = {
  getProjectRoot,
  getAiAgentHome,
  getAiAgentWorkspace,
  getReservationRuntimeDir,
  getReservationRuntimeFile,
  getReadableReservationRuntimeFile,
  getReservationBrowserProfileRoot,
  ensureDir,
  ensureParentDir,
  normalizeReservationRelPath,
  resolveReservationChildRuntime,
  resolveReservationManualScript,
};
