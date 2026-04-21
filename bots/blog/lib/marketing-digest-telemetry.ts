'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');

const BLOG_ROOT = path.join(env.PROJECT_ROOT, 'bots', 'blog');
const MARKETING_DIGEST_TELEMETRY_PATH = path.join(BLOG_ROOT, 'output', 'ops', 'marketing-digest-run.json');

function buildMarketingDigestTelemetry(digest = {}) {
  return {
    checkedAt: new Date().toISOString(),
    status: String(digest?.health?.status || 'unknown'),
    reason: String(digest?.health?.reason || ''),
    topSignal: String(digest?.senseSummary?.topSignal?.message || ''),
    channelWatchHint: String(digest?.channelPerformance?.primaryWatchHint || ''),
    recommendation: Array.isArray(digest?.recommendations) ? String(digest.recommendations[0] || '') : '',
    nextPreviewTitle: String(digest?.nextGeneralPreview?.title || ''),
  };
}

function writeMarketingDigestTelemetry(digest = {}) {
  const payload = buildMarketingDigestTelemetry(digest);
  fs.mkdirSync(path.dirname(MARKETING_DIGEST_TELEMETRY_PATH), { recursive: true });
  fs.writeFileSync(MARKETING_DIGEST_TELEMETRY_PATH, JSON.stringify(payload, null, 2));
  return payload;
}

function readMarketingDigestTelemetry() {
  try {
    const raw = fs.readFileSync(MARKETING_DIGEST_TELEMETRY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

module.exports = {
  MARKETING_DIGEST_TELEMETRY_PATH,
  buildMarketingDigestTelemetry,
  writeMarketingDigestTelemetry,
  readMarketingDigestTelemetry,
};
