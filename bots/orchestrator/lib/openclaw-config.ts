// @ts-nocheck
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function getOpenClawConfigPath() {
  return path.join(os.homedir(), '.openclaw', 'openclaw.json');
}

function getOpenClawMainSessionsPath() {
  return path.join(os.homedir(), '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');
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

function _getProviderProfile(config = {}, provider = '') {
  const normalized = String(provider || '').trim();
  if (!normalized) return null;
  const lastGood = config?.auth?.lastGood || {};
  if (lastGood[normalized]) return lastGood[normalized];
  const profiles = config?.auth?.profiles || {};
  const direct = Object.keys(profiles).find((key) => profiles[key]?.provider === normalized);
  if (direct) return direct;

  try {
    const authPath = getOpenClawAgentAuthPath();
    if (!fs.existsSync(authPath)) return null;
    const agentAuth = readJsonFile(authPath);
    const agentLastGood = agentAuth?.lastGood || {};
    if (agentLastGood[normalized]) return agentLastGood[normalized];
    const agentProfiles = agentAuth?.profiles || {};
    return Object.keys(agentProfiles).find((key) => agentProfiles[key]?.provider === normalized) || null;
  } catch {
    return null;
  }
}

function _modelToProvider(modelId = '') {
  return String(modelId || '').split('/')[0] || '';
}

function getPreferredOpenClawIngressModel() {
  const gateway = getOpenClawGatewayModelState();
  if (!gateway.ok) {
    return {
      ok: false,
      model: null,
      provider: null,
      authProfile: null,
      error: gateway.error || 'gateway state unavailable',
    };
  }

  const preferredCandidates = [
    gateway.primary,
    ...(gateway.readyFallbacks || []),
    ...(gateway.fallbacks || []),
  ].filter(Boolean);

  const selectedModel = preferredCandidates[0] || gateway.primary || null;
  const provider = _modelToProvider(selectedModel);
  const { config } = readOpenClawConfig();
  const authProfile = _getProviderProfile(config, provider);

  return {
    ok: Boolean(selectedModel),
    model: selectedModel,
    provider,
    authProfile,
    source: selectedModel === gateway.primary ? 'primary' : 'fallback',
  };
}

function normalizeOpenClawMainIngressSessions(options = {}) {
  const sessionsPath = options.sessionsPath || getOpenClawMainSessionsPath();
  const dryRun = Boolean(options.dryRun);
  const staleModels = new Set([
    'gemini-2.5-flash-lite',
    'google-gemini-cli/gemini-2.5-flash-lite',
  ]);
  const preferred = getPreferredOpenClawIngressModel();
  if (!preferred.ok || !preferred.model || !preferred.provider) {
    return {
      ok: false,
      sessionsPath,
      changed: false,
      updated: [],
      skipped: [],
      error: preferred.error || 'preferred ingress model unavailable',
    };
  }

  const raw = fs.readFileSync(sessionsPath, 'utf8');
  const sessions = JSON.parse(raw);
  const updated = [];
  const skipped = [];

  for (const [sessionKey, session] of Object.entries(sessions || {})) {
    const channel = String(session?.channel || session?.origin?.provider || '').trim();
    const isTelegram = channel === 'telegram' || sessionKey.startsWith('agent:main:telegram:');
    const isIngressHook = sessionKey.startsWith('agent:main:hook:ingress');
    if (!isTelegram && !isIngressHook) continue;

    const currentProvider = String(session?.modelProvider || '').trim();
    const currentModel = String(session?.model || '').trim();
    const currentComposite = currentProvider && currentModel ? `${currentProvider}/${currentModel}` : currentModel;
    const needsRepair =
      currentProvider !== preferred.provider ||
      currentModel !== preferred.model.replace(`${preferred.provider}/`, '') ||
      staleModels.has(currentModel) ||
      staleModels.has(currentComposite);

    if (!needsRepair) {
      skipped.push({ sessionKey, model: currentComposite || currentModel || null });
      continue;
    }

    session.modelProvider = preferred.provider;
    session.model = preferred.model.replace(`${preferred.provider}/`, '');
    if (preferred.authProfile) {
      session.authProfileOverride = preferred.authProfile;
      session.authProfileOverrideSource = 'auto-healed';
      session.authProfileOverrideCompactionCount = 0;
    }

    updated.push({
      sessionKey,
      before: currentComposite || currentModel || null,
      after: preferred.model,
    });
  }

  if (updated.length > 0 && !dryRun) {
    fs.writeFileSync(sessionsPath, `${JSON.stringify(sessions, null, 2)}\n`, 'utf8');
  }

  return {
    ok: true,
    sessionsPath,
    changed: updated.length > 0,
    updated,
    skipped,
    preferredModel: preferred.model,
    preferredProvider: preferred.provider,
    authProfile: preferred.authProfile || null,
  };
}

module.exports = {
  getOpenClawConfigPath,
  getOpenClawMainSessionsPath,
  getOpenClawAgentAuthPath,
  extractProviderFromModel,
  getOpenClawGatewayModelState,
  getPreferredOpenClawIngressModel,
  normalizeOpenClawMainIngressSessions,
  updateOpenClawGatewayPrimary,
  updateOpenClawGatewayFallbacks,
  updateOpenClawGatewayConcurrency,
};
