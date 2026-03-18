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

function getOpenClawGatewayModelState() {
  try {
    const { filePath, config } = readOpenClawConfig();
    const primary = config?.agents?.defaults?.model?.primary || null;
    const fallbacks = Array.isArray(config?.agents?.defaults?.model?.fallbacks)
      ? config.agents.defaults.model.fallbacks
      : [];
    return {
      ok: true,
      filePath,
      primary,
      fallbacks,
    };
  } catch (error) {
    return {
      ok: false,
      filePath: getOpenClawConfigPath(),
      primary: null,
      fallbacks: [],
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

module.exports = {
  getOpenClawConfigPath,
  getOpenClawGatewayModelState,
  updateOpenClawGatewayPrimary,
};
