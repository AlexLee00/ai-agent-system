// @ts-nocheck
'use strict';

const { selectBonusInsights } = require('./bonus-insights.ts');
const { getBlogSectionVariationRuntimeConfig } = require('./runtime-config.ts');
const { loadStrategyBundle } = require('./strategy-loader.ts');

const DEFAULTS = {
  common: {
    greetingStyles: ['formal', 'question', 'story'],
    cafePositions: ['after_theory', 'after_code', 'before_faq', 'last'],
    listStyles: ['number', 'bullet', 'mixed'],
    bridgeIntervals: [800, 1000, 1200, 1500],
    imageCount: { min: 0, max: 5 },
    includeInstaProbability: 0.4,
  },
  lecture: {
    faqCount: { min: 3, max: 6 },
    insightCount: { min: 2, max: 5 },
    codeBlockCount: { min: 2, max: 5 },
  },
  general: {
    faqCount: { min: 3, max: 6 },
    bodyCount: { min: 2, max: 4 },
  },
};

function mergeRange(base = {}, override = {}) {
  return {
    min: override.min ?? base.min,
    max: override.max ?? base.max,
  };
}

function pickArray(override, fallback) {
  return Array.isArray(override) && override.length ? override : fallback;
}

function buildCommonConfig(commonDefaults = {}, commonRuntime = {}, scopedRuntime = {}) {
  const merged = {
    ...commonDefaults,
    ...commonRuntime,
    greetingStyles: pickArray(scopedRuntime.greetingStyles, pickArray(commonRuntime.greetingStyles, commonDefaults.greetingStyles)),
    cafePositions: pickArray(scopedRuntime.cafePositions, pickArray(commonRuntime.cafePositions, commonDefaults.cafePositions)),
    listStyles: pickArray(scopedRuntime.listStyles, pickArray(commonRuntime.listStyles, commonDefaults.listStyles)),
    bridgeIntervals: pickArray(scopedRuntime.bridgeIntervals, pickArray(commonRuntime.bridgeIntervals, commonDefaults.bridgeIntervals)),
  };

  return {
    ...merged,
    imageCount: mergeRange(commonDefaults.imageCount, {
      ...(commonRuntime.imageCount || {}),
      ...(scopedRuntime.imageCount || {}),
    }),
    includeInstaProbability:
      scopedRuntime.includeInstaProbability
      ?? commonRuntime.includeInstaProbability
      ?? commonDefaults.includeInstaProbability,
  };
}

function getSectionVariationConfig(postType = 'general') {
  const runtime = getBlogSectionVariationRuntimeConfig() || {};
  const commonRuntime = runtime.common || {};
  const scopedDefaults = postType === 'lecture' ? DEFAULTS.lecture : DEFAULTS.general;
  const scopedRuntime = postType === 'lecture' ? (runtime.lecture || {}) : (runtime.general || {});
  return {
    common: buildCommonConfig(DEFAULTS.common, commonRuntime, scopedRuntime),
    scoped: {
      ...scopedDefaults,
      ...scopedRuntime,
      faqCount: mergeRange(scopedDefaults.faqCount, scopedRuntime.faqCount || {}),
      ...(postType === 'lecture'
        ? {
            insightCount: mergeRange(scopedDefaults.insightCount, scopedRuntime.insightCount || {}),
            codeBlockCount: mergeRange(scopedDefaults.codeBlockCount, scopedRuntime.codeBlockCount || {}),
          }
        : {
            bodyCount: mergeRange(scopedDefaults.bodyCount, scopedRuntime.bodyCount || {}),
          }),
    },
  };
}

function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function buildUsedVariationSets(history = []) {
  return {
    usedGreetings: new Set(history.map((h) => h.variations?.greetingStyle).filter(Boolean)),
    usedCafePositions: new Set(history.map((h) => h.variations?.cafePosition).filter(Boolean)),
  };
}

function pickFreshOrAny(allValues, usedValues) {
  const availableValues = allValues.filter((value) => !usedValues.has(value));
  return availableValues.length > 0 ? pick(availableValues) : pick(allValues);
}

function buildBonusInsights(postType, history = []) {
  const botType = postType === 'lecture' ? 'pos' : 'gems';
  const recentBonusIds = history.flatMap((h) => (h.variations?.bonusInsights || []).map((b) => b.id));
  const { executionDirectives } = loadStrategyBundle();
  const creativePolicy = executionDirectives?.creativePolicy || {};
  const titlePolicy = executionDirectives?.titlePolicy || {};
  const baseSelected = selectBonusInsights(botType, recentBonusIds);
  const maxBonusCount = creativePolicy.reelAggro === 'high'
    ? 3
    : titlePolicy.tone === 'conversion'
      ? 1
      : 2;
  return baseSelected.slice(0, maxBonusCount);
}

function buildDynamicVariation(postType, history = []) {
  const { common, scoped } = getSectionVariationConfig(postType);
  const { executionDirectives } = loadStrategyBundle();
  const channelPriority = executionDirectives?.channelPriority || {};
  const creativePolicy = executionDirectives?.creativePolicy || {};
  const titlePolicy = executionDirectives?.titlePolicy || {};
  const { usedGreetings, usedCafePositions } = buildUsedVariationSets(history);
  const greetingStyle = pickFreshOrAny(common.greetingStyles, usedGreetings);
  const cafePosition = pickFreshOrAny(common.cafePositions, usedCafePositions);
  const bonusInsights = buildBonusInsights(postType, history);
  const includeInstaProbability = Number(
    channelPriority.instagram === 'primary'
      ? 0.9
      : channelPriority.instagram === 'secondary'
        ? 0.65
        : common.includeInstaProbability ?? DEFAULTS.common.includeInstaProbability
  );
  const imageCountMax = creativePolicy.imageAggro === 'high'
    ? Math.max(common.imageCount?.max ?? DEFAULTS.common.imageCount.max, 6)
    : creativePolicy.imageAggro === 'low'
      ? Math.min(common.imageCount?.max ?? DEFAULTS.common.imageCount.max, 3)
      : (common.imageCount?.max ?? DEFAULTS.common.imageCount.max);
  const imageCountMin = creativePolicy.imageAggro === 'high'
    ? Math.max(common.imageCount?.min ?? DEFAULTS.common.imageCount.min, 1)
    : (common.imageCount?.min ?? DEFAULTS.common.imageCount.min);

  const variation = {
    greetingStyle,
    faqCount: randInt(scoped.faqCount?.min ?? 3, scoped.faqCount?.max ?? 6),
    listStyle: pick(common.listStyles),
    bridgeInterval: pick(common.bridgeIntervals),
    includeInsta: Math.random() < includeInstaProbability,
    imageCount: randInt(imageCountMin, imageCountMax),
    cafePosition,
    bonusInsights,
    totalInsights: 4 + bonusInsights.length,
  };

  if (postType === 'lecture') {
    const insightMin = titlePolicy.tone === 'conversion'
      ? Math.max(scoped.insightCount?.min ?? 2, 2)
      : creativePolicy.reelAggro === 'high'
        ? Math.max(scoped.insightCount?.min ?? 2, 3)
        : (scoped.insightCount?.min ?? 2);
    const insightMax = creativePolicy.reelAggro === 'high'
      ? Math.max(scoped.insightCount?.max ?? 5, 6)
      : (scoped.insightCount?.max ?? 5);
    variation.insightCount = randInt(insightMin, insightMax);
    variation.codeBlockCount = randInt(scoped.codeBlockCount?.min ?? 2, scoped.codeBlockCount?.max ?? 5);
  } else {
    const bodyMin = titlePolicy.tone === 'conversion'
      ? Math.max(scoped.bodyCount?.min ?? 2, 2)
      : creativePolicy.reelAggro === 'high'
        ? Math.max(scoped.bodyCount?.min ?? 2, 3)
        : (scoped.bodyCount?.min ?? 2);
    const bodyMax = titlePolicy.tone === 'conversion'
      ? Math.min(scoped.bodyCount?.max ?? 4, 3)
      : creativePolicy.reelAggro === 'high'
        ? Math.max(scoped.bodyCount?.max ?? 4, 5)
        : (scoped.bodyCount?.max ?? 4);
    variation.bodyCount = randInt(bodyMin, Math.max(bodyMin, bodyMax));
  }

  return variation;
}

module.exports = {
  getSectionVariationConfig,
  randInt,
  pick,
  buildUsedVariationSets,
  pickFreshOrAny,
  buildBonusInsights,
  buildDynamicVariation,
};
