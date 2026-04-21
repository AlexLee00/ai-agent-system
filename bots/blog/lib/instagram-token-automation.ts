'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');

const AUTO_REFRESH_RESULT_PATH = path.join(
  env.PROJECT_ROOT,
  'bots',
  'blog',
  'output',
  'ops',
  'instagram-token-auto-refresh.json',
);

const AUTO_REFRESH_SCHEDULE_TEXT = '매일 05:40, 17:40 KST';

function readInstagramTokenAutoRefreshResult() {
  try {
    return JSON.parse(fs.readFileSync(AUTO_REFRESH_RESULT_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeInstagramTokenAutoRefreshResult(payload = {}) {
  fs.mkdirSync(path.dirname(AUTO_REFRESH_RESULT_PATH), { recursive: true });
  fs.writeFileSync(AUTO_REFRESH_RESULT_PATH, JSON.stringify(payload, null, 2));
}

module.exports = {
  AUTO_REFRESH_RESULT_PATH,
  AUTO_REFRESH_SCHEDULE_TEXT,
  readInstagramTokenAutoRefreshResult,
  writeInstagramTokenAutoRefreshResult,
};
