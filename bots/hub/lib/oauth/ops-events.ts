// @ts-nocheck

const fs = require('fs');
const path = require('path');
const eventLake = require('../../../../packages/core/lib/event-lake');

const SECRET_KEY_PATTERN = /(access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|api[_-]?key|client[_-]?secret|password|secret)/i;

function enabled(name, fallback = true) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw);
}

function normalizeProvider(key) {
  return String(key || '')
    .replace(/_oauth$/i, '-oauth')
    .replace(/_/g, '-')
    .replace(/claude-code-oauth/i, 'claude-code-oauth')
    .replace(/openai-oauth/i, 'openai-oauth')
    .replace(/gemini-cli-oauth/i, 'gemini-cli-oauth')
    .replace(/gemini-codeassist-service/i, 'gemini-codeassist-service')
    .replace(/gemini-codeassist-oauth/i, 'gemini-codeassist-oauth')
    .replace(/gemini-oauth/i, 'gemini-oauth');
}

function scrub(value, depth = 0) {
  if (depth > 5) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => scrub(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, raw] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      output[key] = '[redacted]';
      continue;
    }
    output[key] = scrub(raw, depth + 1);
  }
  return output;
}

function oauthEventCachePath() {
  const workspace = String(process.env.AI_AGENT_WORKSPACE || '').trim();
  if (workspace) return path.join(workspace, 'oauth-monitor-event-cache.json');
  return path.join(process.env.HOME || '/tmp', '.ai-agent-system', 'workspace', 'oauth-monitor-event-cache.json');
}

function oauthEventCooldownMs(event) {
  if (event.severity === 'error') return 0;
  if (event.kind === 'degraded' || event.kind === 'near_expiry') return 15 * 60 * 1000;
  if (event.kind === 'reimport_success' || event.kind === 'refresh_success' || event.kind === 'live_probe_success' || event.kind === 'success') {
    return 2 * 60 * 60 * 1000;
  }
  return 0;
}

function shouldSuppressRepeatedEvent(event) {
  const cooldownMs = oauthEventCooldownMs(event);
  if (cooldownMs <= 0) return false;
  const signature = `${String(event.provider || 'unknown')}|${String(event.kind || 'event')}|${String(event.severity || 'info')}`;

  try {
    const cachePath = oauthEventCachePath();
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const now = Date.now();
    let cache = {};
    if (fs.existsSync(cachePath)) {
      cache = JSON.parse(fs.readFileSync(cachePath, 'utf8') || '{}');
    }
    cache = Object.fromEntries(
      Object.entries(cache).filter(([, row]) => now - Number(row?.last_seen_at || row?.emitted_at || 0) < 24 * 60 * 60 * 1000)
    );
    const prev = cache[signature];
    if (prev && now - Number(prev.emitted_at || 0) < cooldownMs) {
      cache[signature] = {
        ...prev,
        last_seen_at: now,
        count: Number(prev.count || 0) + 1,
      };
      fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
      return true;
    }
    cache[signature] = {
      emitted_at: now,
      last_seen_at: now,
      count: 1,
    };
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  } catch (error) {
    console.warn(`[oauth-ops-events] dedupe cache 실패: ${String(error?.message || error)}`);
  }

  return false;
}

function providerEntries(report) {
  return [
    ['claude-code-oauth', report?.claude_code_oauth],
    ['openai-oauth', report?.openai_oauth],
    ['gemini-oauth', report?.gemini_oauth],
    ['gemini-cli-oauth', report?.gemini_cli_oauth],
    ['gemini-codeassist-service', report?.gemini_codeassist_service],
  ].filter(([, status]) => status && typeof status === 'object');
}

function buildProviderEvents(report) {
  const emitOkEvents = enabled('HUB_OAUTH_MONITOR_EMIT_OK_EVENTS', false);
  const events = [];

  for (const [providerKey, status] of providerEntries(report)) {
    const provider = normalizeProvider(providerKey);
    const skipped = Boolean(status.skipped);
    const healthy = Boolean(status.healthy);
    const needsRefresh = Boolean(status.needs_refresh);
    const localCredentialNeedsRefresh = Boolean(status.local_credential_needs_refresh);
    const degraded = Boolean(status.degraded);
    const refreshOk = status.refresh_ok === true;
    const reimportOk = status.reimport_ok === true || status.post_probe_reimport_ok === true;
    const liveProbeOk = status.live_probe_ok === true || status.live_refresh_ok === true;
    const expiresInHours = Number.isFinite(Number(status.expires_in_hours))
      ? Number(status.expires_in_hours)
      : null;

    if (!healthy && !skipped) {
      events.push({
        kind: 'failure',
        severity: 'error',
        provider,
        title: `OAuth provider unhealthy: ${provider}`,
        message: String(status.error || 'oauth_provider_unhealthy').slice(0, 240),
        metadata: status,
      });
      continue;
    }

    if (degraded) {
      events.push({
        kind: 'failure',
        severity: 'warn',
        provider,
        title: `OAuth provider degraded: ${provider}`,
        message: String(status.error || 'oauth_provider_degraded').slice(0, 240),
        metadata: status,
      });
      continue;
    }

    if (needsRefresh) {
      events.push({
        kind: 'near_expiry',
        severity: 'warn',
        provider,
        title: `OAuth provider near expiry: ${provider}`,
        message: expiresInHours == null
          ? 'OAuth token is in refresh window'
          : `OAuth token expires in ${Math.round(expiresInHours * 100) / 100}h`,
        metadata: status,
      });
      continue;
    }

    if (localCredentialNeedsRefresh && reimportOk) {
      events.push({
        kind: 'reimport_success',
        severity: 'info',
        provider,
        title: `OAuth local reimport succeeded: ${provider}`,
        message: 'OAuth local credential reimport completed through Hub monitor',
        metadata: status,
      });
      continue;
    }

    if (localCredentialNeedsRefresh && liveProbeOk && !reimportOk) {
      events.push({
        kind: 'degraded',
        severity: 'warn',
        provider,
        title: `OAuth local reimport pending: ${provider}`,
        message: 'OAuth live route recovered, but local credential reimport did not complete',
        metadata: status,
      });
      continue;
    }

    if (refreshOk) {
      events.push({
        kind: 'refresh_success',
        severity: 'info',
        provider,
        title: `OAuth refresh succeeded: ${provider}`,
        message: 'OAuth refresh completed through Hub monitor',
        metadata: status,
      });
      continue;
    }

    if (reimportOk) {
      events.push({
        kind: 'reimport_success',
        severity: 'info',
        provider,
        title: `OAuth local reimport succeeded: ${provider}`,
        message: 'OAuth local credential reimport completed through Hub monitor',
        metadata: status,
      });
      continue;
    }

    if (liveProbeOk && emitOkEvents) {
      events.push({
        kind: 'live_probe_success',
        severity: 'info',
        provider,
        title: `OAuth live probe succeeded: ${provider}`,
        message: 'OAuth live route probe succeeded through Hub monitor',
        metadata: status,
      });
      continue;
    }

    if (emitOkEvents && healthy && !skipped) {
      events.push({
        kind: 'success',
        severity: 'info',
        provider,
        title: `OAuth provider healthy: ${provider}`,
        message: 'OAuth provider is healthy',
        metadata: status,
      });
    }
  }

  return events;
}

async function publishOAuthOpsEvent(event) {
  if (!enabled('HUB_OAUTH_MONITOR_PUBLISH_EVENTS', true)) {
    return { ok: false, skipped: true, reason: 'disabled' };
  }
  if (shouldSuppressRepeatedEvent(event)) {
    return { ok: false, skipped: true, reason: 'deduped' };
  }

  try {
    const id = await eventLake.record({
      eventType: 'hub_oauth_monitor',
      team: 'hub',
      botName: 'hub-oauth-monitor',
      severity: event.severity || 'info',
      title: event.title || 'OAuth monitor event',
      message: event.message || '',
      tags: [
        'oauth',
        'monitor',
        String(event.kind || 'event'),
        String(event.provider || 'unknown'),
      ],
      metadata: scrub({
        source: 'hub_oauth_monitor',
        event_kind: event.kind || 'event',
        provider: event.provider || 'unknown',
        checked_at: new Date().toISOString(),
        ...(event.metadata || {}),
      }),
    });
    return { ok: true, id };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error || 'oauth_event_publish_failed').slice(0, 240),
    };
  }
}

async function publishOAuthMonitorEvents(report) {
  const events = buildProviderEvents(report);
  const results = [];
  for (const event of events) {
    results.push(await publishOAuthOpsEvent(event));
  }
  return {
    ok: results.every((result) => result.ok || result.skipped),
    attempted: events.length,
    published: results.filter((result) => result.ok).length,
    skipped: results.filter((result) => result.skipped).length,
    failed: results.filter((result) => !result.ok && !result.skipped).length,
    results,
  };
}

module.exports = {
  buildProviderEvents,
  shouldSuppressRepeatedOauthEvent: shouldSuppressRepeatedEvent,
  publishOAuthOpsEvent,
  publishOAuthMonitorEvents,
  scrubOAuthOpsPayload: scrub,
};
