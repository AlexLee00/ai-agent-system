'use strict';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const DEFAULT_TELEMETRY_PATH = path.join(os.homedir(), '.ai-agent-system/workspace/darwin/telemetry.jsonl');

function getTelemetryPath(envObj: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(envObj.DARWIN_TELEMETRY_PATH || DEFAULT_TELEMETRY_PATH);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'unknown_error');
}

function recordTelemetry(event: Record<string, unknown>, options: { env?: NodeJS.ProcessEnv; silent?: boolean } = {}) {
  const filePath = getTelemetryPath(options.env || process.env);
  const payload = {
    at: new Date().toISOString(),
    ...event,
  };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
    return { ok: true, path: filePath, event: payload };
  } catch (error) {
    if (!options.silent) {
      console.warn(`[darwin-telemetry] append failed: ${toErrorMessage(error)}`);
    }
    return { ok: false, path: filePath, error: toErrorMessage(error) };
  }
}

async function withTelemetry<T>(
  phase: string,
  fn: () => Promise<T> | T,
  context: Record<string, unknown> = {},
): Promise<T> {
  const startedAt = Date.now();
  recordTelemetry({ phase, event: 'start', ...context });
  try {
    const result = await fn();
    recordTelemetry({
      phase,
      event: 'end',
      ok: true,
      durationMs: Date.now() - startedAt,
      ...context,
    });
    return result;
  } catch (error) {
    recordTelemetry({
      phase,
      event: 'end',
      ok: false,
      durationMs: Date.now() - startedAt,
      error: toErrorMessage(error),
      ...context,
    });
    throw error;
  }
}

function tailTelemetry(limit = 20, filePath = getTelemetryPath()): Array<Record<string, unknown>> {
  if (!fs.existsSync(filePath)) return [];
  const count = Math.max(1, Math.min(200, Math.trunc(limit)));
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-count)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

module.exports = {
  DEFAULT_TELEMETRY_PATH,
  getTelemetryPath,
  recordTelemetry,
  withTelemetry,
  tailTelemetry,
};
