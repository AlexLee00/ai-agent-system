'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');

const COMMENTER_RUN_RESULT_PATH = path.join(
  env.PROJECT_ROOT,
  'bots',
  'blog',
  'output',
  'ops',
  'commenter-run.json',
);

function readCommenterRunResult() {
  try {
    return JSON.parse(fs.readFileSync(COMMENTER_RUN_RESULT_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeCommenterRunResult(payload = {}) {
  fs.mkdirSync(path.dirname(COMMENTER_RUN_RESULT_PATH), { recursive: true });
  fs.writeFileSync(COMMENTER_RUN_RESULT_PATH, JSON.stringify(payload, null, 2));
}

module.exports = {
  COMMENTER_RUN_RESULT_PATH,
  readCommenterRunResult,
  writeCommenterRunResult,
};
