// @ts-nocheck
'use strict';

const { selectBonusInsights } = require('./bonus-insights.ts');
const { getBlogSectionVariationRuntimeConfig } = require('./runtime-config.ts');

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
  return selectBonusInsights(botType, recentBonusIds);
}

function buildDynamicVariation(postType, history = []) {
  const { common, scoped } = getSectionVariationConfig(postType);
  const { usedGreetings, usedCafePositions } = buildUsedVariationSets(history);
  const greetingStyle = pickFreshOrAny(common.greetingStyles, usedGreetings);
  const cafePosition = pickFreshOrAny(common.cafePositions, usedCafePositions);
  const bonusInsights = buildBonusInsights(postType, history);

  const variation = {
    greetingStyle,
    faqCount: randInt(scoped.faqCount?.min ?? 3, scoped.faqCount?.max ?? 6),
    listStyle: pick(common.listStyles),
    bridgeInterval: pick(common.bridgeIntervals),
    includeInsta: Math.random() < Number(common.includeInstaProbability ?? DEFAULTS.common.includeInstaProbability),
    imageCount: randInt(common.imageCount?.min ?? DEFAULTS.common.imageCount.min, common.imageCount?.max ?? DEFAULTS.common.imageCount.max),
    cafePosition,
    bonusInsights,
    totalInsights: 4 + bonusInsights.length,
  };

  if (postType === 'lecture') {
    variation.insightCount = randInt(scoped.insightCount?.min ?? 2, scoped.insightCount?.max ?? 5);
    variation.codeBlockCount = randInt(scoped.codeBlockCount?.min ?? 2, scoped.codeBlockCount?.max ?? 5);
  } else {
    variation.bodyCount = randInt(scoped.bodyCount?.min ?? 2, scoped.bodyCount?.max ?? 4);
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
