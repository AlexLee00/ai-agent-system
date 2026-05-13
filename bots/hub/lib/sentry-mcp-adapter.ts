import type { Request } from 'express';

const crypto = require('node:crypto');
const https = require('node:https');

const REDACTED = '[redacted]';
const SECRET_PATTERNS = [
  /(sk-[A-Za-z0-9_-]{12,})/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  /(authorization["']?\s*[:=]\s*["']?)[^"',\s]+/gi,
  /(api[_-]?key["']?\s*[:=]\s*["']?)[^"',\s]+/gi,
  /(token["']?\s*[:=]\s*["']?)[^"',\s]+/gi,
];

let sentThisMinute = 0;
let minuteBucket = Math.floor(Date.now() / 60_000);

function redact(value: unknown): string {
  let text = String(value ?? '');
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (_match: string, prefix?: string) => prefix ? `${prefix}${REDACTED}` : REDACTED);
  }
  return text.slice(0, 4_000);
}

function parseDsn(dsn: string): null | { projectId: string; publicKey: string; host: string; path: string } {
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.split('/').filter(Boolean).pop();
    if (!projectId || !url.username || !url.host) return null;
    return {
      projectId,
      publicKey: url.username,
      host: url.host,
      path: `/api/${projectId}/store/`,
    };
  } catch {
    return null;
  }
}

function rateLimitAllows(): boolean {
  const current = Math.floor(Date.now() / 60_000);
  if (current !== minuteBucket) {
    minuteBucket = current;
    sentThisMinute = 0;
  }
  const limit = Math.max(1, Math.min(60, Number(process.env.HUB_SENTRY_MAX_EVENTS_PER_MINUTE || 10)));
  if (sentThisMinute >= limit) return false;
  sentThisMinute += 1;
  return true;
}

function sanitizeHubError(error: unknown, req?: Request) {
  const context = (req as any)?.hubRequestContext || {};
  const headers = req?.headers || {};
  return {
    event_id: crypto.randomBytes(16).toString('hex'),
    timestamp: new Date().toISOString(),
    platform: 'node',
    logger: 'hub.stage_d',
    level: 'error',
    message: redact((error as any)?.message || error),
    tags: {
      service: 'hub',
      stage: 'stage_d',
      method: req?.method || 'unknown',
      path: req?.path || 'unknown',
      caller_team: context.callerTeam || 'unknown',
      agent: context.agent || 'unknown',
    },
    extra: {
      trace_id: context.traceId || null,
      priority: context.priority || null,
      user_agent: redact(headers['user-agent'] || ''),
    },
  };
}

function postToSentry(dsn: string, event: Record<string, unknown>): Promise<{ ok: boolean; status?: number; error?: string }> {
  const parsed = parseDsn(dsn);
  if (!parsed) return Promise.resolve({ ok: false, error: 'invalid_sentry_dsn' });

  const body = JSON.stringify(event);
  const auth = [
    'Sentry sentry_version=7',
    `sentry_client=ai-agent-system-hub/1.0`,
    `sentry_key=${parsed.publicKey}`,
  ].join(', ');

  return new Promise((resolve) => {
    const req = https.request({
      hostname: parsed.host,
      path: parsed.path,
      method: 'POST',
      timeout: 5_000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Sentry-Auth': auth,
      },
    }, (res: any) => {
      res.resume();
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
    });
    req.on('error', (error: Error) => resolve({ ok: false, error: error.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout' });
    });
    req.end(body);
  });
}

function captureHubError(error: unknown, req?: Request): void {
  if (process.env.HUB_SENTRY_CAPTURE_ENABLED !== 'true') return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || !rateLimitAllows()) return;

  const event = sanitizeHubError(error, req);
  void postToSentry(dsn, event).then((result) => {
    if (!result.ok) {
      console.warn(`[hub-sentry] capture failed: ${result.error || result.status || 'unknown'}`);
    }
  }).catch((err: Error) => {
    console.warn(`[hub-sentry] capture failed: ${err.message}`);
  });
}

function buildSentryMcpReadiness() {
  const dsnConfigured = Boolean(process.env.SENTRY_DSN);
  return {
    ok: true,
    mode: dsnConfigured && process.env.HUB_SENTRY_CAPTURE_ENABLED === 'true'
      ? 'capture_enabled'
      : dsnConfigured
        ? 'dsn_configured_capture_disabled'
        : 'adapter_ready_config_pending',
    captureEnabled: process.env.HUB_SENTRY_CAPTURE_ENABLED === 'true',
    dsnConfigured,
    piiRedaction: true,
    rateLimitPerMinute: Math.max(1, Math.min(60, Number(process.env.HUB_SENTRY_MAX_EVENTS_PER_MINUTE || 10))),
  };
}

module.exports = {
  buildSentryMcpReadiness,
  captureHubError,
  parseDsn,
  postToSentry,
  redact,
  sanitizeHubError,
};
