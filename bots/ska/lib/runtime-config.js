'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_RUNTIME_CONFIG = {
  forecast: {
    conditionAdjustmentWeight: 0.50,
    reservationAdjustmentWeight: 0.42,
    shadowModelEnabled: true,
    shadowModelName: 'knn-shadow-v1',
    shadowNeighborCount: 7,
    shadowMinimumTrainRows: 21,
    shadowPromotionMapeGap: 2.0,
    sarimaPeriods: 7,
    sarimaMaxIter: 200,
    perModelAccuracyDays: 30,
    minimumModelWeight: 0.1,
    llmDiagnosisRagThreshold: 0.6,
    monthlyReviewGradeGood: 12,
    monthlyReviewGradeWarn: 22,
    weekdayBiasAlertAmount: 20000,
  },
  rebecca: {
    weeklyGradeGood: 10,
    weeklyGradeWarn: 20,
    anomalyRagThreshold: 0.55,
  },
  reviews: {
    daily: {
      minDays: 7,
      defaultDays: 30,
      avgMapeWarn: 20,
      avgMapeNotice: 12,
      avgBiasWarn: 30000,
      hitRate20Warn: 70,
      avgReservationGapWarn: 5,
      confidenceWarn: 0.4,
      upcomingDays: 3,
    },
    weekly: {
      minDays: 14,
      defaultDays: 56,
      avgMapeWarn: 20,
      avgMapeNotice: 12,
      avgBiasWarn: 150000,
      confidenceWarn: 0.4,
      weekdayMapeWarn: 20,
      upcomingDays: 7,
    },
  },
};

let cachedConfig = null;

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isObject(base) || !isObject(override)) return override ?? base;
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = isObject(value) && isObject(base[key])
      ? deepMerge(base[key], value)
      : value;
  }
  return merged;
}

function loadSkaRuntimeConfig() {
  if (cachedConfig) return cachedConfig;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
    cachedConfig = deepMerge(DEFAULT_RUNTIME_CONFIG, raw.runtime_config || {});
    return cachedConfig;
  } catch {
    cachedConfig = { ...DEFAULT_RUNTIME_CONFIG };
    return cachedConfig;
  }
}

function getSkaForecastConfig() {
  return loadSkaRuntimeConfig().forecast;
}

function getSkaRebeccaConfig() {
  return loadSkaRuntimeConfig().rebecca;
}

function getSkaReviewConfig() {
  return loadSkaRuntimeConfig().reviews;
}

module.exports = {
  loadSkaRuntimeConfig,
  getSkaForecastConfig,
  getSkaRebeccaConfig,
  getSkaReviewConfig,
};
