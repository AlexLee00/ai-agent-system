// @ts-nocheck
'use strict';

const RETIRED_AT = '2026-07-23';

function isBlogMarketingRetired() {
  return true;
}

function isBlogSnsPublishingRetired() {
  return true;
}

function buildRetiredFeatureResult(feature = 'blog-feature') {
  return {
    ok: true,
    skipped: true,
    retired: true,
    feature,
    reason: 'blog_feature_retired',
    retiredAt: RETIRED_AT,
  };
}

module.exports = {
  RETIRED_AT,
  isBlogMarketingRetired,
  isBlogSnsPublishingRetired,
  buildRetiredFeatureResult,
};
