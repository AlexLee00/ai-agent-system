// @ts-nocheck
'use strict';

const RETIRED_REASON = 'Legacy gateway config is retired. Use Hub selector/control-plane APIs instead.';

function isLegacyGatewayAdminEnabled() {
  return false;
}

function assertRetired(operation) {
  throw new Error(`${operation} is permanently retired. ${RETIRED_REASON}`);
}

function getRetiredGatewayConfigPath() {
  return null;
}

function getRetiredGatewayMainSessionsPath() {
  return null;
}

function getRetiredGatewayAgentAuthPath() {
  return null;
}

function extractProviderFromModel(modelId) {
  const normalized = String(modelId || '').trim();
  if (!normalized.includes('/')) return null;
  return normalized.split('/')[0] || null;
}

function getRetiredGatewayModelState() {
  return {
    ok: false,
    retired: true,
    filePath: null,
    primary: null,
    fallbacks: [],
    fallbackReadiness: [],
    readyFallbacks: [],
    unreadyFallbacks: [],
    availableProviders: [],
    readyProviders: [],
    authPath: null,
    agentAuthProviders: {},
    error: RETIRED_REASON,
  };
}

function getPreferredRetiredGatewayIngressModel() {
  return {
    ok: false,
    retired: true,
    model: null,
    provider: null,
    authProfile: null,
    error: RETIRED_REASON,
  };
}

function normalizeRetiredGatewayMainIngressSessions() {
  assertRetired('normalizeRetiredGatewayMainIngressSessions');
}

function updateRetiredGatewayPrimary() {
  assertRetired('updateRetiredGatewayPrimary');
}

function updateRetiredGatewayFallbacks() {
  assertRetired('updateRetiredGatewayFallbacks');
}

function updateRetiredGatewayConcurrency() {
  assertRetired('updateRetiredGatewayConcurrency');
}

module.exports = {
  getRetiredGatewayConfigPath,
  getRetiredGatewayMainSessionsPath,
  getRetiredGatewayAgentAuthPath,
  extractProviderFromModel,
  getRetiredGatewayModelState,
  getPreferredRetiredGatewayIngressModel,
  normalizeRetiredGatewayMainIngressSessions,
  updateRetiredGatewayPrimary,
  updateRetiredGatewayFallbacks,
  updateRetiredGatewayConcurrency,
  isLegacyGatewayAdminEnabled,
};
