'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

const DEFAULTS = {
  lead: {
    defaultPollMs: 2000,
    noTokenPollMs: 30000,
    telegramLongPollSeconds: 10,
    telegramRequestTimeoutMs: 15000,
  },
  health: {
    httpTimeoutMs: 5000,
  },
  n8n: {
    healthUrl: 'http://127.0.0.1:5678/healthz',
    workerWebhookUrl: 'http://127.0.0.1:5678/webhook/worker-chat-intake',
    healthTimeoutMs: 2500,
    webhookTimeoutMs: 5000,
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

function getWorkerLeadRuntimeConfig() {
  return loadRuntimeConfig().lead;
}

function getWorkerHealthRuntimeConfig() {
  return loadRuntimeConfig().health;
}

function getWorkerN8nRuntimeConfig() {
  return loadRuntimeConfig().n8n;
}

module.exports = {
  getWorkerLeadRuntimeConfig,
  getWorkerHealthRuntimeConfig,
  getWorkerN8nRuntimeConfig,
};
