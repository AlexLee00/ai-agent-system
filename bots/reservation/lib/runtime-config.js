const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const DEFAULT_RUNTIME_CONFIG = {
  browser: {
    launchRetries: 3,
    launchRetryDelayMs: 2000,
    navigationTimeoutMs: 30000,
    pickkoProtocolTimeoutMs: 180000,
  },
  naverMonitor: {
    maxRetries: 5,
    errorTrackerThreshold: 3,
    staleConfirmCount: 5,
    staleMinElapsedMs: 10 * 60 * 1000,
    staleExpireMs: 30 * 60 * 1000,
  },
  kioskMonitor: {
    errorTrackerThreshold: 3,
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

function loadRuntimeConfig() {
  if (cachedConfig) return cachedConfig;
  try {
    const raw = yaml.load(fs.readFileSync(path.join(__dirname, '..', 'config.yaml'), 'utf8')) || {};
    cachedConfig = deepMerge(DEFAULT_RUNTIME_CONFIG, raw.runtime_config || {});
    return cachedConfig;
  } catch {
    cachedConfig = { ...DEFAULT_RUNTIME_CONFIG };
    return cachedConfig;
  }
}

function getReservationRuntimeConfig() {
  return loadRuntimeConfig();
}

function getReservationBrowserConfig() {
  return loadRuntimeConfig().browser;
}

function getReservationNaverMonitorConfig() {
  return loadRuntimeConfig().naverMonitor;
}

function getReservationKioskMonitorConfig() {
  return loadRuntimeConfig().kioskMonitor;
}

module.exports = {
  getReservationRuntimeConfig,
  getReservationBrowserConfig,
  getReservationNaverMonitorConfig,
  getReservationKioskMonitorConfig,
};
