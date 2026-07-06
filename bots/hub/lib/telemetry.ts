// @ts-nocheck
'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const pendingWrites = new Set();

function telemetryPath() {
  return process.env.HUB_TELEMETRY_PATH
    || path.join(os.homedir(), '.ai-agent-system', 'workspace', 'hub', 'telemetry.jsonl');
}

function redact(value, depth = 0) {
  if (depth > 5) return '[depth-limit]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(token|secret|password|authorization|api[_-]?key|credential)/i.test(key)) out[key] = '[redacted]';
    else out[key] = redact(item, depth + 1);
  }
  return out;
}

function recordHubTelemetry(stage, payload = {}) {
  try {
    const filePath = telemetryPath();
    const line = `${JSON.stringify({
      createdAt: new Date().toISOString(),
      stage: String(stage || 'hub_event'),
      ...redact(payload),
    })}\n`;
    const write = fs.mkdir(path.dirname(filePath), { recursive: true })
      .then(() => fs.appendFile(filePath, line))
      .catch((error) => {
        if (process.env.HUB_TELEMETRY_DEBUG === 'true') {
          console.warn('[hub-telemetry] append skipped:', error?.message || error);
        }
      })
      .finally(() => pendingWrites.delete(write));
    pendingWrites.add(write);
    return { ok: true, path: filePath };
  } catch (error) {
    if (process.env.HUB_TELEMETRY_DEBUG === 'true') {
      console.warn('[hub-telemetry] append skipped:', error?.message || error);
    }
    return { ok: false, error: String(error?.message || error) };
  }
}

async function flushHubTelemetry() {
  await Promise.allSettled([...pendingWrites]);
}

module.exports = { recordHubTelemetry, telemetryPath, flushHubTelemetry };
