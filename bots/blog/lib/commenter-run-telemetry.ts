// @ts-nocheck
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

function normalizeCommentClassifications(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized = {};
  for (const [key, count] of Object.entries(value)) {
    const type = String(key || '').trim();
    const numericCount = Math.max(0, Number(count || 0));
    if (type && Number.isFinite(numericCount) && numericCount > 0) {
      normalized[type] = numericCount;
    }
  }
  return normalized;
}

function writeCommenterRunResult(payload = {}) {
  fs.mkdirSync(path.dirname(COMMENTER_RUN_RESULT_PATH), { recursive: true });
  fs.writeFileSync(COMMENTER_RUN_RESULT_PATH, JSON.stringify({
    ...payload,
    commentClassifications: normalizeCommentClassifications(payload.commentClassifications),
  }, null, 2));
}

module.exports = {
  COMMENTER_RUN_RESULT_PATH,
  readCommenterRunResult,
  normalizeCommentClassifications,
  writeCommenterRunResult,
};
