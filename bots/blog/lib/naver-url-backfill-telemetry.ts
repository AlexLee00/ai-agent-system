'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');

const NAVER_URL_BACKFILL_PATH = path.join(
  env.PROJECT_ROOT,
  'bots',
  'blog',
  'output',
  'ops',
  'naver-url-backfill.json',
);

function readNaverUrlBackfillTelemetry() {
  try {
    return JSON.parse(fs.readFileSync(NAVER_URL_BACKFILL_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeNaverUrlBackfillTelemetry(payload = {}) {
  fs.mkdirSync(path.dirname(NAVER_URL_BACKFILL_PATH), { recursive: true });
  fs.writeFileSync(NAVER_URL_BACKFILL_PATH, JSON.stringify(payload, null, 2));
}

module.exports = {
  NAVER_URL_BACKFILL_PATH,
  readNaverUrlBackfillTelemetry,
  writeNaverUrlBackfillTelemetry,
};
