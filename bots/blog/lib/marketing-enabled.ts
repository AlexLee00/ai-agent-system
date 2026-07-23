// @ts-nocheck
'use strict';

const { buildRetiredFeatureResult } = require('./retirement-policy.ts');

function isBlogMarketingEnabled() {
  return false;
}

function buildMarketingDisabledResult(source = 'blog-marketing') {
  return {
    ...buildRetiredFeatureResult(source),
    source,
    marketingEnabled: false,
    generatedAt: new Date().toISOString(),
  };
}

function logMarketingDisabled(source = 'blog-marketing') {
  console.log(`[${source}] 블로그 마케팅 기능 은퇴 — 실행 경로 스킵`);
}

module.exports = {
  isBlogMarketingEnabled,
  buildMarketingDisabledResult,
  logMarketingDisabled,
};
