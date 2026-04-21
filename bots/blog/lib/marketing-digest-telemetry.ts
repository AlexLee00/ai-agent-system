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

function describeMarketingDigestAge(latestDigestRun = null, now = new Date()) {
  const checkedAtMs = Date.parse(String(latestDigestRun?.checkedAt || ''));
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now || ''));
  if (!Number.isFinite(checkedAtMs) || !Number.isFinite(nowMs) || nowMs < checkedAtMs) {
    return { minutes: null, text: '' };
  }
  const minutes = Math.floor((nowMs - checkedAtMs) / 60000);
  if (minutes < 60) return { minutes, text: `${minutes}m ago` };
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  if (hours < 24) return { minutes, text: remainMinutes > 0 ? `${hours}h ${remainMinutes}m ago` : `${hours}h ago` };
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return { minutes, text: remainHours > 0 ? `${days}d ${remainHours}h ago` : `${days}d ago` };
}

module.exports = {
  MARKETING_DIGEST_TELEMETRY_PATH,
  buildMarketingDigestTelemetry,
  writeMarketingDigestTelemetry,
  readMarketingDigestTelemetry,
  describeMarketingDigestAge,
};
