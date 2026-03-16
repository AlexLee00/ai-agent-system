'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_RUNTIME_CONFIG = {
  health: {
    n8nHealthUrl: 'http://127.0.0.1:5678/healthz',
    criticalWebhookUrl: 'http://127.0.0.1:5678/webhook/critical',
    httpTimeoutMs: 2500,
    webhookTimeoutMs: 5000,
    payloadWarningWithinHours: 24,
    payloadWarningLimit: 50,
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

function loadOrchestratorRuntimeConfig() {
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

function getOrchestratorHealthConfig() {
  return loadOrchestratorRuntimeConfig().health;
}

module.exports = {
  loadOrchestratorRuntimeConfig,
  getOrchestratorHealthConfig,
};
