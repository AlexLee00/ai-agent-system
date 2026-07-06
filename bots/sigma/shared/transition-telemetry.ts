// @ts-nocheck

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function transitionTelemetryPath(env = process.env) {
  return env.SIGMA_TRANSITION_TELEMETRY_PATH
    || path.join(os.homedir(), '.ai-agent-system/workspace/sigma/transition-telemetry.jsonl');
}

export function appendTransitionTelemetry(event = {}, options = {}) {
  const filePath = options.path || transitionTelemetryPath(options.env || process.env);
  const payload = {
    at: new Date().toISOString(),
    ...event,
  };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
    return { ok: true, path: filePath };
  } catch (error) {
    return {
      ok: false,
      path: filePath,
      error: String(error?.message || error),
    };
  }
}

export default {
  transitionTelemetryPath,
  appendTransitionTelemetry,
};
