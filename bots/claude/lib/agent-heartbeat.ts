// @ts-nocheck
'use strict';

const HEARTBEAT_PREFIX = 'claude-';

function normalizeAgentName(agentName) {
  const normalized = String(agentName || '').trim();
  if (!normalized) return null;
  return normalized.startsWith(HEARTBEAT_PREFIX) ? normalized : `${HEARTBEAT_PREFIX}${normalized}`;
}

function messageFromError(error) {
  return String(error?.message || error || 'unknown_error').slice(0, 500);
}

function compactMeta(meta = {}) {
  const result = {};
  for (const [key, value] of Object.entries(meta || {})) {
    if (value === undefined) continue;
    result[key] = value;
  }
  return result;
}

async function writeClaudeHeartbeat(agentName, status = 'ok', meta = {}) {
  const normalized = normalizeAgentName(agentName);
  if (!normalized) return { ok: false, skipped: true, reason: 'missing_agent_name' };
  try {
    const { writeHeartbeat } = require('../../../packages/core/lib/agent-heartbeats');
    await writeHeartbeat(normalized, status, compactMeta(meta));
    return { ok: true, agentName: normalized, status };
  } catch (error) {
    return { ok: false, agentName: normalized, status, error: messageFromError(error) };
  }
}

function errorHeartbeatMeta(error, meta = {}) {
  return compactMeta({
    ...meta,
    message: messageFromError(error),
  });
}

module.exports = {
  writeClaudeHeartbeat,
  errorHeartbeatMeta,
  normalizeAgentName,
};
