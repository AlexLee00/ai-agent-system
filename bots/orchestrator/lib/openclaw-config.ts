// @ts-nocheck
'use strict';

const RETIRED_REASON = 'OpenClaw gateway config is retired. Use Hub selector/control-plane APIs instead.';

function isLegacyOpenClawAdminEnabled() {
  return false;
}

function assertRetired(operation) {
  throw new Error(`${operation} is permanently retired. ${RETIRED_REASON}`);
}

function getOpenClawConfigPath() {
  return null;
}

function getOpenClawMainSessionsPath() {
  return null;
}

function getOpenClawAgentAuthPath() {
  return null;
}

function extractProviderFromModel(modelId) {
  const normalized = String(modelId || '').trim();
  if (!normalized.includes('/')) return null;
  return normalized.split('/')[0] || null;
}

function getOpenClawGatewayModelState() {
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

function getPreferredOpenClawIngressModel() {
  return {
    ok: false,
    retired: true,
    model: null,
    provider: null,
    authProfile: null,
    error: RETIRED_REASON,
  };
}

function normalizeOpenClawMainIngressSessions() {
  assertRetired('normalizeOpenClawMainIngressSessions');
}

function updateOpenClawGatewayPrimary() {
  assertRetired('updateOpenClawGatewayPrimary');
}

function updateOpenClawGatewayFallbacks() {
  assertRetired('updateOpenClawGatewayFallbacks');
}

function updateOpenClawGatewayConcurrency() {
  assertRetired('updateOpenClawGatewayConcurrency');
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
  isLegacyOpenClawAdminEnabled,
};
