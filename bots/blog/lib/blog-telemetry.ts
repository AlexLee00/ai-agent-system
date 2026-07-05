// @ts-nocheck
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const kst = require('../../../packages/core/lib/kst');

const DEFAULT_BLOG_TELEMETRY_PATH = path.join(os.homedir(), '.ai-agent-system/workspace/blog/telemetry.jsonl');

function getBlogTelemetryPath(envObj = process.env) {
  return path.resolve(envObj.BLOG_TELEMETRY_PATH || DEFAULT_BLOG_TELEMETRY_PATH);
}

function errorMessage(error) {
  return error?.message || String(error || 'unknown_error');
}

function recordBlogTelemetry(event = {}, options = {}) {
  const filePath = getBlogTelemetryPath(options.env || process.env);
  const payload = {
    at: kst.datetimeStr(),
    team: 'blog',
    ...event,
  };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
    return { ok: true, path: filePath, event: payload };
  } catch (error) {
    if (!options.silent) {
      console.warn(`[blog-telemetry] append failed: ${errorMessage(error)}`);
    }
    return { ok: false, path: filePath, error: errorMessage(error) };
  }
}

async function withBlogTelemetry(stage, fn, context = {}) {
  const startedAt = Date.now();
  recordBlogTelemetry({ stage, event: 'start', ...context }, { silent: true });
  try {
    const result = await fn();
    recordBlogTelemetry({
      stage,
      event: 'end',
      ok: true,
      durationMs: Date.now() - startedAt,
      ...context,
    }, { silent: true });
    return result;
  } catch (error) {
    recordBlogTelemetry({
      stage,
      event: 'end',
      ok: false,
      durationMs: Date.now() - startedAt,
      error: errorMessage(error),
      ...context,
    }, { silent: true });
    throw error;
  }
}

function tailBlogTelemetry(limit = 20, filePath = getBlogTelemetryPath()) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-Math.max(1, Math.min(200, Number(limit || 20))))
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

module.exports = {
  DEFAULT_BLOG_TELEMETRY_PATH,
  getBlogTelemetryPath,
  recordBlogTelemetry,
  withBlogTelemetry,
  tailBlogTelemetry,
};
