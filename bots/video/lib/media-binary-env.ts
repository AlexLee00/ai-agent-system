// @ts-nocheck
'use strict';

const EXTRA_MEDIA_PATHS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/opt/local/bin',
  '/usr/bin',
  '/bin',
];

function buildMediaBinaryPath(basePath = '') {
  const entries = String(basePath || '')
    .split(pathSeparator())
    .filter(Boolean);
  const merged = [...entries];

  for (const candidate of EXTRA_MEDIA_PATHS) {
    if (!merged.includes(candidate)) {
      merged.push(candidate);
    }
  }

  return merged.join(pathSeparator());
}

function buildMediaBinaryEnv(baseEnv = process.env) {
  return {
    ...baseEnv,
    PATH: buildMediaBinaryPath(baseEnv?.PATH || ''),
  };
}

function applyMediaBinaryEnv(targetEnv = process.env) {
  const nextPath = buildMediaBinaryPath(targetEnv?.PATH || '');
  targetEnv.PATH = nextPath;
  return nextPath;
}

function pathSeparator() {
  return process.platform === 'win32' ? ';' : ':';
}

module.exports = {
  buildMediaBinaryEnv,
  applyMediaBinaryEnv,
};
