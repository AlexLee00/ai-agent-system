'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');

const STRATEGY_PATH = path.join(env.PROJECT_ROOT, 'bots/blog/output/strategy/latest-strategy.json');

type BlogStrategyPlan = {
  executionDirectives?: Record<string, any>;
  preferredTitlePattern?: unknown;
  suppressedTitlePattern?: unknown;
  dailyMixPolicy?: Record<string, any>;
};

function loadLatestStrategy(): BlogStrategyPlan | null {
  try {
    if (!fs.existsSync(STRATEGY_PATH)) return null;
    const raw = fs.readFileSync(STRATEGY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed?.plan || null;
  } catch {
    return null;
  }
}

function normalizeExecutionDirectives(strategy: BlogStrategyPlan | null = null) {
  const directives = strategy?.executionDirectives || {};
  const channelPriority = directives.channelPriority || {};
  const executionTargets = directives.executionTargets || {};
  const titlePolicy = directives.titlePolicy || {};
  const hashtagPolicy = directives.hashtagPolicy || {};
  const creativePolicy = directives.creativePolicy || {};

  return {
    channelPriority: {
      naverBlog: channelPriority.naverBlog || 'primary',
      instagram: 'retired',
      facebook: 'retired',
    },
    executionTargets: {
      blogRegistrationsPerCycle: Number(executionTargets.blogRegistrationsPerCycle || 1),
      instagramRegistrationsPerCycle: 0,
      facebookRegistrationsPerCycle: 0,
      replyTargetPerCycle: Number(executionTargets.replyTargetPerCycle || 1),
      neighborCommentTargetPerCycle: 1,
      sympathyTargetPerCycle: 1,
    },
    titlePolicy: {
      preferredPattern: titlePolicy.preferredPattern || strategy?.preferredTitlePattern || null,
      suppressedPattern: titlePolicy.suppressedPattern || strategy?.suppressedTitlePattern || null,
      tone: titlePolicy.tone || 'balanced',
      keywordBias: Array.isArray(titlePolicy.keywordBias) ? titlePolicy.keywordBias : [],
    },
    hashtagPolicy: {
      mode: hashtagPolicy.mode || 'balanced',
      focusTags: Array.isArray(hashtagPolicy.focusTags) ? hashtagPolicy.focusTags : [],
      platformTags: Array.isArray(hashtagPolicy.platformTags) ? hashtagPolicy.platformTags : [],
    },
    creativePolicy: {
      imageAggro: creativePolicy.imageAggro || 'medium',
      reelAggro: creativePolicy.reelAggro || 'medium',
      hookStyle: creativePolicy.hookStyle || 'balanced',
      ctaStyle: creativePolicy.ctaStyle || 'balanced',
      imageDirection: creativePolicy.imageDirection || 'premium curiosity',
      // Omnichannel 확장 필드 (구버전 없으면 default)
      reelHookIntensity: creativePolicy.reelHookIntensity || 'balanced',
      thumbnailAggro: creativePolicy.thumbnailAggro || 'medium',
      storyInteractionMode: creativePolicy.storyInteractionMode || 'brand_story',
      facebookConversationMode: creativePolicy.facebookConversationMode || 'community',
    },
    // Omnichannel 필드 (구버전 없으면 default)
    campaignMix: {
      cafeLibraryRatio: Number(directives.campaignMix?.cafeLibraryRatio ?? 0.5),
      seunghoDadRatio: Number(directives.campaignMix?.seunghoDadRatio ?? 0.5),
      conversionRatio: Number(directives.campaignMix?.conversionRatio ?? 0.3),
      brandTrustRatio: Number(directives.campaignMix?.brandTrustRatio ?? 0.2),
    },
    platformTargets: {
      naverBlog: { postsPerCycle: Number(directives.platformTargets?.naverBlog?.postsPerCycle ?? 1) },
      instagram: {
        feedPerCycle: 0,
        reelsPerCycle: 0,
        storiesPerCycle: 0,
      },
      facebook: { postsPerCycle: 0 },
    },
    engagementPolicy: {
      inboundReplyTarget: Number(directives.engagementPolicy?.inboundReplyTarget ?? 1),
      outboundNeighborCommentTarget: 1,
      sympathyTarget: 1,
      lowExposureEscalationThreshold: Number(directives.engagementPolicy?.lowExposureEscalationThreshold ?? 3),
    },
    attributionPolicy: {
      utmNaming: directives.attributionPolicy?.utmNaming || 'brand_axis__platform__objective',
      attributionWindowDays: Number(directives.attributionPolicy?.attributionWindowDays ?? 7),
      revenueUpliftThreshold: Number(directives.attributionPolicy?.revenueUpliftThreshold ?? 0.05),
    },
    socialNativeRequired: false,
  };
}

function normalizeDailyMixPolicy(strategy: BlogStrategyPlan | null = null) {
  const policy = strategy?.dailyMixPolicy || {};
  return {
    primaryCategory: policy.primaryCategory || null,
    secondaryCategory: policy.secondaryCategory || null,
    suppressedCategory: policy.suppressedCategory || null,
    titlePatternFocus: policy.titlePatternFocus || null,
    weakTitlePattern: policy.weakTitlePattern || null,
    rotationMode: policy.rotationMode || 'balanced',
    stabilityMode: policy.stabilityMode === true,
    lectureMode: policy.lectureMode || 'balanced',
    generalMode: policy.generalMode || 'balanced',
  };
}

function loadStrategyBundle() {
  const plan = loadLatestStrategy();
  const directives = normalizeExecutionDirectives(plan);
  return {
    plan,
    executionDirectives: directives,
    directives,  // alias for convenience in omnichannel modules
    dailyMixPolicy: normalizeDailyMixPolicy(plan),
  };
}

function resolveExecutionTarget(name = '', strategy: BlogStrategyPlan | null = null, fallback = 0) {
  const directives = normalizeExecutionDirectives(strategy);
  const executionTargets = directives.executionTargets as Record<string, unknown>;
  return Number(executionTargets?.[name] || fallback || 0);
}

function resolveCreativeValue(name = '', strategy: BlogStrategyPlan | null = null, fallback: unknown = null) {
  const directives = normalizeExecutionDirectives(strategy);
  const creativePolicy = directives.creativePolicy as Record<string, unknown>;
  return creativePolicy?.[name] ?? fallback;
}

module.exports = {
  STRATEGY_PATH,
  loadLatestStrategy,
  normalizeExecutionDirectives,
  normalizeDailyMixPolicy,
  loadStrategyBundle,
  resolveExecutionTarget,
  resolveCreativeValue,
};
