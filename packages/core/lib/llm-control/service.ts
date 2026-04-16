// @ts-nocheck
'use strict';

const selector = require('../llm-model-selector');
const advisor = require('../llm-selector-advisor');
const snapshot = require('./snapshot');

function getSpeedContext(speedSnapshot = snapshot.loadLatestSpeedSnapshot()) {
  return {
    speedSnapshot,
    speedLookup: advisor.buildSpeedLookup(speedSnapshot),
  };
}

function describeSelectorWithAdvice(key, options = {}, speedSnapshot = snapshot.loadLatestSpeedSnapshot()) {
  const description = selector.describeLLMSelector(key, options);
  const { speedLookup } = getSpeedContext(speedSnapshot);
  return {
    description,
    advice: advisor.buildSelectorAdvice(description, speedLookup),
    speedSnapshot,
  };
}

module.exports = {
  ...selector,
  ...advisor,
  ...snapshot,
  getSpeedContext,
  describeSelectorWithAdvice,
};
