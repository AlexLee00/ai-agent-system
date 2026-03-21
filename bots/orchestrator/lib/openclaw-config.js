'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function getOpenClawConfigPath() {
  return path.join(os.homedir(), '.openclaw', 'openclaw.json');
}

function readOpenClawConfig() {
  const filePath = getOpenClawConfigPath();
  const raw = fs.readFileSync(filePath, 'utf8');
  return { filePath, config: JSON.parse(raw) };
}

function getOpenClawAgentAuthPath() {
  return path.join(os.homedir(), '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json');
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function summarizeAgentAuthProfiles(authConfig = {}) {
  const profiles = authConfig?.profiles || {};
  const summary = {};
  for (const profile of Object.values(profiles)) {
    const provider = String(profile?.provider || '').trim();
    if (!provider) continue;
    const hasKey = typeof profile?.key === 'string' ? profile.key.trim().length > 0 : true;
    const hasAccess = typeof profile?.access === 'string' ? profile.access.trim().length > 0 : false;
    const ready = hasKey || hasAccess;
    if (!summary[provider]) {
      summary[provider] = {
        registered: 0,
        readyProfiles: 0,
      };
    }
    summary[provider].registered += 1;
    if (ready) summary[provider].readyProfiles += 1;
  }
  return summary;
}

function extractProviderFromModel(modelId) {
  const normalized = String(modelId || '').trim();
  if (!normalized.includes('/')) return null;
  return normalized.split('/')[0] || null;
}

function getOpenClawGatewayModelState() {
  try {
    const { filePath, config } = readOpenClawConfig();
    const primary = config?.agents?.defaults?.model?.primary || null;
    const fallbacks = Array.isArray(config?.agents?.defaults?.model?.fallbacks)
      ? config.agents.defaults.model.fallbacks
      : [];
    const authProfiles = config?.auth?.profiles || {};
    const availableProviders = Array.from(new Set(
      Object.values(authProfiles)
        .map((item) => item?.provider)
        .filter(Boolean),
    ));
    const authPath = getOpenClawAgentAuthPath();
    const authConfig = fs.existsSync(authPath) ? readJsonFile(authPath) : null;
    const agentAuthProviders = summarizeAgentAuthProfiles(authConfig || {});
    const readyProviders = Object.entries(agentAuthProviders)
      .filter(([, state]) => Number(state.readyProfiles || 0) > 0)
      .map(([provider]) => provider);
    const fallbackReadiness = fallbacks.map((modelId) => {
      const provider = extractProviderFromModel(modelId);
      return {
        model: modelId,
        provider,
        ready: provider ? readyProviders.includes(provider) : false,
      };
    });
    const readyFallbacks = fallbackReadiness.filter((item) => item.ready).map((item) => item.model);
    const unreadyFallbacks = fallbackReadiness.filter((item) => !item.ready).map((item) => item.model);
    return {
      ok: true,
      filePath,
      primary,
      fallbacks,
      fallbackReadiness,
      readyFallbacks,
      unreadyFallbacks,
      availableProviders,
      readyProviders,
      authPath,
      agentAuthProviders,
    };
  } catch (error) {
    return {
      ok: false,
      filePath: getOpenClawConfigPath(),
      primary: null,
      fallbacks: [],
      fallbackReadiness: [],
      readyFallbacks: [],
      unreadyFallbacks: [],
      availableProviders: [],
      readyProviders: [],
      authPath: getOpenClawAgentAuthPath(),
      agentAuthProviders: {},
      error: error.message,
    };
  }
}

function updateOpenClawGatewayPrimary(nextPrimary) {
  const normalized = String(nextPrimary || '').trim();
  if (!normalized) {
    throw new Error('nextPrimary is required');
  }
  const { filePath, config } = readOpenClawConfig();
  if (!config.agents) config.agents = {};
  if (!config.agents.defaults) config.agents.defaults = {};
  if (!config.agents.defaults.model) config.agents.defaults.model = {};
  config.agents.defaults.model.primary = normalized;
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return {
    filePath,
    primary: normalized,
  };
}

function updateOpenClawGatewayFallbacks(nextFallbacks = []) {
  if (!Array.isArray(nextFallbacks)) {
    throw new Error('nextFallbacks must be an array');
  }
  const normalized = nextFallbacks
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const deduped = normalized.filter((value, index) => normalized.indexOf(value) === index);
  const { filePath, config } = readOpenClawConfig();
  if (!config.agents) config.agents = {};
  if (!config.agents.defaults) config.agents.defaults = {};
  if (!config.agents.defaults.model) config.agents.defaults.model = {};
  config.agents.defaults.model.fallbacks = deduped;
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return {
    filePath,
    fallbacks: deduped,
    fallbackCount: deduped.length,
  };
}

function updateOpenClawGatewayConcurrency({ maxConcurrent, subagentMaxConcurrent }) {
  const normalizedMax = Number(maxConcurrent);
  const normalizedSub = Number(subagentMaxConcurrent);
  if (!Number.isFinite(normalizedMax) || normalizedMax < 1) {
    throw new Error('maxConcurrent must be a positive number');
  }
  if (!Number.isFinite(normalizedSub) || normalizedSub < 1) {
    throw new Error('subagentMaxConcurrent must be a positive number');
  }
  const { filePath, config } = readOpenClawConfig();
  if (!config.agents) config.agents = {};
  if (!config.agents.defaults) config.agents.defaults = {};
  if (!config.agents.defaults.subagents) config.agents.defaults.subagents = {};
  config.agents.defaults.maxConcurrent = normalizedMax;
  config.agents.defaults.subagents.maxConcurrent = normalizedSub;
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return {
    filePath,
    maxConcurrent: normalizedMax,
    subagentMaxConcurrent: normalizedSub,
  };
}

module.exports = {
  getOpenClawConfigPath,
  getOpenClawAgentAuthPath,
  extractProviderFromModel,
  getOpenClawGatewayModelState,
  updateOpenClawGatewayPrimary,
  updateOpenClawGatewayFallbacks,
  updateOpenClawGatewayConcurrency,
};
