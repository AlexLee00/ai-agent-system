'use strict';

const { createBotCommandAdapter } = require('./base-command-adapter');

function normalizeText(value, fallback = '') {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function parseBoolean(value, fallback = false) {
  const text = normalizeText(value, fallback ? 'true' : 'false').toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(text);
}

function resolveAdapterMode(team, defaultMode = 'virtual') {
  const key = `JAY_COMMANDER_ADAPTER_${String(team || '').toUpperCase()}_MODE`;
  const explicit = normalizeText(process.env[key], '');
  if (explicit === 'virtual' || explicit === 'bot_command') return explicit;
  return defaultMode;
}

function createTeamCommanderAdapter(team, options = {}) {
  const normalizedTeam = normalizeText(team, 'general').toLowerCase();
  const toBot = normalizeText(options.toBot, normalizedTeam);
  const timeoutMs = Math.max(15_000, Number(options.timeoutMs || 300_000) || 300_000);
  const commandQueueEnabled = parseBoolean(process.env.JAY_COMMANDER_BOT_QUEUE_ENABLED, false);
  const defaultMode = commandQueueEnabled ? 'bot_command' : 'virtual';
  const mode = resolveAdapterMode(normalizedTeam, defaultMode);
  if (mode === 'bot_command') {
    return createBotCommandAdapter(normalizedTeam, { toBot, timeoutMs });
  }
  return createBotCommandAdapter(normalizedTeam, { toBot: '', timeoutMs });
}

module.exports = {
  createTeamCommanderAdapter,
};
