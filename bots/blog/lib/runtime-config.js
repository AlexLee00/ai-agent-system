'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

const DEFAULTS = {
  health: {
    nodeServerHealthUrl: 'http://127.0.0.1:3100/health',
    n8nHealthUrl: 'http://127.0.0.1:5678/healthz',
    blogWebhookUrl: 'http://127.0.0.1:5678/webhook/blog-pipeline',
    nodeServerTimeoutMs: 3000,
    n8nHealthTimeoutMs: 2500,
    webhookTimeoutMs: 5000,
    dailyLogStaleMs: 36 * 60 * 60 * 1000,
  },
  generation: {
    gemsMinChars: 8000,
    posMinChars: 7000,
    continueMaxTokens: 8000,
    writerMaxRetries: 1,
    maestroWebhookTimeoutMs: 180000,
    maestroHealthTimeoutMs: 2500,
    maestroCircuitCooldownMs: 30 * 60 * 1000,
  },
};

function mergeDeep(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
  const next = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      next[key] = mergeDeep(base[key], value);
    } else {
      next[key] = value;
    }
  }
  return next;
}

function loadRuntimeConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return mergeDeep(DEFAULTS, parsed.runtime_config || {});
  } catch {
    return DEFAULTS;
  }
}

function getBlogHealthRuntimeConfig() {
  return loadRuntimeConfig().health;
}

function getBlogGenerationRuntimeConfig() {
  return loadRuntimeConfig().generation;
}

module.exports = {
  getBlogHealthRuntimeConfig,
  getBlogGenerationRuntimeConfig,
};
