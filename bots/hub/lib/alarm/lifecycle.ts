// @ts-nocheck
'use strict';

const crypto = require('node:crypto');

function truthy(value) {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value || '').trim().toLowerCase());
}

function isAlarmLifecycleEnabled(env = process.env) {
  return truthy(env.HUB_ALARM_LIFECYCLE_ENABLED);
}

function normalizeText(value, fallback = '') {
  return String(value == null ? fallback : value).trim() || fallback;
}

function normalizeKeyPart(value) {
  return normalizeText(value, 'unknown')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, 'url')
    .replace(/[0-9a-f]{8,}/gi, 'hash')
    .replace(/\d{4}-\d{2}-\d{2}/g, 'date')
    .replace(/\d+/g, 'n')
    .replace(/[^a-z0-9가-힣._:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'unknown';
}

function buildAlarmLifecycleFingerprint(input = {}) {
  const team = normalizeKeyPart(input.team || 'general');
  const alarmType = normalizeKeyPart(input.alarmType || input.alarm_type || 'work');
  const key = normalizeKeyPart(
    input.normalizedKey
      || input.incidentKey
      || input.incident_key
      || input.clusterKey
      || input.cluster_key
      || input.eventType
      || input.title
      || input.message
      || 'alarm',
  );
  const hash = crypto.createHash('sha256').update(`${team}|${alarmType}|${key}`).digest('hex').slice(0, 24);
  return {
    fingerprint: `hub_alarm:${hash}`,
    labels: { team, alarmType, key },
  };
}

function repeatIntervalMinutes(env = process.env) {
  const hours = Number(env.HUB_ALARM_REPEAT_INTERVAL_HOURS || 6);
  return Math.max(1, Math.trunc((Number.isFinite(hours) && hours > 0 ? hours : 6) * 60));
}

function buildRepeatDecision(input = {}, env = process.env) {
  const minutes = repeatIntervalMinutes(env);
  const previousAt = input.previousAt ? new Date(String(input.previousAt)).getTime() : 0;
  const now = input.now ? new Date(String(input.now)).getTime() : Date.now();
  const suppress = previousAt > 0 && now - previousAt < minutes * 60_000;
  return {
    repeatIntervalMinutes: minutes,
    suppress,
    nextAllowedAt: previousAt > 0 ? new Date(previousAt + minutes * 60_000).toISOString() : null,
  };
}

function buildTtlAutoResolvePlan(rows = [], options = {}) {
  const now = options.now ? new Date(String(options.now)).getTime() : Date.now();
  return rows
    .map((row) => {
      const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
      const ttlAt = metadata.ttl_auto_resolve_at || metadata.ttlAutoResolveAt || row.ttl_auto_resolve_at;
      const expiresAt = ttlAt ? new Date(String(ttlAt)).getTime() : 0;
      const status = normalizeText(row.status || 'new').toLowerCase();
      const shouldResolve = expiresAt > 0 && expiresAt <= now && !['resolved', 'suppressed'].includes(status);
      return {
        id: row.id ?? null,
        fingerprint: row.fingerprint || metadata.incident_key || null,
        shouldResolve,
        reason: shouldResolve ? 'ttl_auto_resolve_expired' : 'not_due',
        resolvedAt: shouldResolve ? new Date(now).toISOString() : null,
      };
    })
    .filter((item) => item.shouldResolve || options.includeNotDue);
}

function simulateAlarmLifecycle(rows = [], options = {}) {
  const merged = new Map();
  for (const row of rows) {
    const lifecycle = buildAlarmLifecycleFingerprint(row);
    const previous = merged.get(lifecycle.fingerprint) || {
      fingerprint: lifecycle.fingerprint,
      labels: lifecycle.labels,
      count: 0,
      samples: [],
    };
    previous.count += 1;
    previous.samples.push(row.id ?? row.title ?? row.message ?? null);
    merged.set(lifecycle.fingerprint, previous);
  }
  return {
    ok: true,
    enabled: isAlarmLifecycleEnabled(options.env || process.env),
    repeatIntervalMinutes: repeatIntervalMinutes(options.env || process.env),
    merged: [...merged.values()],
    ttlAutoResolve: buildTtlAutoResolvePlan(rows, options),
  };
}

module.exports = {
  buildAlarmLifecycleFingerprint,
  buildRepeatDecision,
  buildTtlAutoResolvePlan,
  isAlarmLifecycleEnabled,
  repeatIntervalMinutes,
  simulateAlarmLifecycle,
  _testOnly: { normalizeKeyPart },
};
