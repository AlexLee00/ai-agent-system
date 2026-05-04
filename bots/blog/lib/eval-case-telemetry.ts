'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');

const BLOG_ROOT = path.join(env.PROJECT_ROOT, 'bots', 'blog');
const BLOG_OPS_DIR = path.join(BLOG_ROOT, 'output', 'ops');
const BLOG_EVAL_CASE_LATEST_PATH = path.join(BLOG_OPS_DIR, 'blog-eval-case-latest.json');
const BLOG_EVAL_CASE_HISTORY_PATH = path.join(BLOG_OPS_DIR, 'blog-eval-case-history.jsonl');

function ensureOpsDir() {
  fs.mkdirSync(BLOG_OPS_DIR, { recursive: true });
}

function normalizeEvalCase(payload: Record<string, unknown> = {}) {
  return {
    capturedAt: new Date().toISOString(),
    area: String(payload.area || 'unknown'),
    subtype: String(payload.subtype || 'unknown'),
    code: String(payload.code || 'unknown'),
    title: String(payload.title || ''),
    summary: String(payload.summary || ''),
    status: String(payload.status || 'failed'),
    source: String(payload.source || ''),
    meta: payload.meta && typeof payload.meta === 'object' ? payload.meta : {},
  };
}

function writeBlogEvalCase(payload: Record<string, unknown> = {}) {
  try {
    const normalized = normalizeEvalCase(payload);
    ensureOpsDir();
    fs.writeFileSync(BLOG_EVAL_CASE_LATEST_PATH, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    fs.appendFileSync(BLOG_EVAL_CASE_HISTORY_PATH, `${JSON.stringify(normalized)}\n`, 'utf8');
    return normalized;
  } catch {
    return null;
  }
}

function readLatestBlogEvalCase(area = '') {
  try {
    const raw = fs.readFileSync(BLOG_EVAL_CASE_LATEST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (area && String(parsed.area || '') !== String(area)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function readRecentBlogEvalCases({ area = '', limit = 10 } = {}) {
  try {
    const raw = fs.readFileSync(BLOG_EVAL_CASE_HISTORY_PATH, 'utf8');
    const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
    const parsed = [];
    for (let index = lines.length - 1; index >= 0 && parsed.length < Math.max(1, Number(limit || 10)); index -= 1) {
      try {
        const item = JSON.parse(lines[index]);
        if (!item || typeof item !== 'object') continue;
        if (area && String(item.area || '') !== String(area)) continue;
        parsed.push(item);
      } catch {}
    }
    return parsed;
  } catch {
    return [];
  }
}

module.exports = {
  BLOG_EVAL_CASE_LATEST_PATH,
  BLOG_EVAL_CASE_HISTORY_PATH,
  writeBlogEvalCase,
  readLatestBlogEvalCase,
  readRecentBlogEvalCases,
};
