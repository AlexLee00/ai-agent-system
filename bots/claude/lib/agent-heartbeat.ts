'use strict';

const HEARTBEAT_PREFIX = 'claude-';

type HeartbeatMeta = Record<string, unknown>;

function normalizeAgentName(agentName: unknown): string | null {
  const normalized = String(agentName || '').trim();
  if (!normalized) return null;
  return normalized.startsWith(HEARTBEAT_PREFIX) ? normalized : `${HEARTBEAT_PREFIX}${normalized}`;
}

function messageFromError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || 'unknown_error');
  return message.slice(0, 500);
}

function compactMeta(meta: HeartbeatMeta = {}): HeartbeatMeta {
  const result: HeartbeatMeta = {};
  for (const [key, value] of Object.entries(meta || {})) {
    if (value === undefined) continue;
    result[key] = value;
  }
  return result;
}

async function writeClaudeHeartbeat(agentName: unknown, status = 'ok', meta: HeartbeatMeta = {}) {
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

function errorHeartbeatMeta(error: unknown, meta: HeartbeatMeta = {}): HeartbeatMeta {
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
