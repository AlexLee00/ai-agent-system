'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');

const STRATEGY_PATH = path.join(env.PROJECT_ROOT, 'bots/blog/output/strategy/latest-strategy.json');

function loadLatestStrategy() {
  try {
    if (!fs.existsSync(STRATEGY_PATH)) return null;
    const raw = fs.readFileSync(STRATEGY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed?.plan || null;
  } catch {
    return null;
  }
}

function normalizeExecutionDirectives(strategy = null) {
  const directives = strategy?.executionDirectives || {};
  const channelPriority = directives.channelPriority || {};
  const executionTargets = directives.executionTargets || {};
  const titlePolicy = directives.titlePolicy || {};
  const hashtagPolicy = directives.hashtagPolicy || {};
  const creativePolicy = directives.creativePolicy || {};

  return {
    channelPriority: {
      naverBlog: channelPriority.naverBlog || 'primary',
      instagram: channelPriority.instagram || 'secondary',
      facebook: channelPriority.facebook || 'supporting',
    },
    executionTargets: {
      blogRegistrationsPerCycle: Number(executionTargets.blogRegistrationsPerCycle || 1),
      instagramRegistrationsPerCycle: Number(executionTargets.instagramRegistrationsPerCycle || 1),
      facebookRegistrationsPerCycle: Number(executionTargets.facebookRegistrationsPerCycle || 1),
      replyTargetPerCycle: Number(executionTargets.replyTargetPerCycle || 1),
      neighborCommentTargetPerCycle: Number(executionTargets.neighborCommentTargetPerCycle || 1),
      sympathyTargetPerCycle: Number(executionTargets.sympathyTargetPerCycle || 1),
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
    },
  };
}

function loadStrategyBundle() {
  const plan = loadLatestStrategy();
  return {
    plan,
    executionDirectives: normalizeExecutionDirectives(plan),
  };
}

function resolveExecutionTarget(name = '', strategy = null, fallback = 0) {
  const directives = normalizeExecutionDirectives(strategy);
  return Number(directives.executionTargets?.[name] || fallback || 0);
}

function resolveCreativeValue(name = '', strategy = null, fallback = null) {
  const directives = normalizeExecutionDirectives(strategy);
  return directives.creativePolicy?.[name] ?? fallback;
}

module.exports = {
  STRATEGY_PATH,
  loadLatestStrategy,
  normalizeExecutionDirectives,
  loadStrategyBundle,
  resolveExecutionTarget,
  resolveCreativeValue,
};
