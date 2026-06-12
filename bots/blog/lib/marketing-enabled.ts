// @ts-nocheck
'use strict';

function isBlogMarketingEnabled() {
  return process.env.BLOG_MARKETING_ENABLED === 'true';
}

function buildMarketingDisabledResult(source = 'blog-marketing') {
  return {
    ok: true,
    skipped: true,
    reason: 'blog_marketing_disabled',
    source,
    marketingEnabled: false,
    generatedAt: new Date().toISOString(),
  };
}

function logMarketingDisabled(source = 'blog-marketing') {
  console.log(`[${source}] BLOG_MARKETING_ENABLED != true — 마케팅 경로 스킵`);
}

module.exports = {
  isBlogMarketingEnabled,
  buildMarketingDisabledResult,
  logMarketingDisabled,
};
