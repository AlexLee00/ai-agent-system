// @ts-nocheck

const crypto = require('crypto');

function slugOAuthAlarmToken(value: unknown, fallback = 'alarm'): string {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return text || fallback;
}

function stableOAuthAlarmHash(value: unknown): string {
  return crypto.createHash('sha1').update(String(value ?? '')).digest('hex').slice(0, 12);
}

function isOAuthManualReauth(payload?: Record<string, unknown> | null): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const error = payload.error;
  const errorObject = error && typeof error === 'object' ? error as Record<string, unknown> : null;
  return payload.manual_reauth_required === true
    || String(errorObject?.kind || '').trim() === 'auth_required'
    || String(errorObject?.google_status || '').trim() === 'UNAUTHENTICATED'
    || Number(errorObject?.status || 0) === 401
    || String(error || '').trim() === 'gemini_codeassist_access_token_missing';
}

function canonicalOAuthAlarmTitle(title?: string, payload?: Record<string, unknown> | null): string {
  const service = String(payload?.service || '').trim();
  if (service === 'cloudaicompanion.googleapis.com' && isOAuthManualReauth(payload)) {
    return '[Hub OAuth] Gemini Code Assist API 비활성/오류';
  }
  return String(title || 'oauth_alarm').trim();
}

export function buildOAuthMonitorAlarmEnvelope({
  level,
  title,
  payload,
  cooldownMs,
}: {
  level?: number;
  title?: string;
  payload?: Record<string, unknown> | null;
  cooldownMs?: number;
}) {
  const alarmLevel = Number(level || 2);
  const provider = String(payload?.provider || '').trim();
  const team = provider === 'claude-code-oauth' ? 'claude' : 'hub';
  const fromBot = 'hub-oauth-monitor';
  const alarmType = alarmLevel >= 3 ? 'error' : 'work';
  const eventType = `${fromBot}_${alarmType}`;
  const manualReauth = isOAuthManualReauth(payload);
  const incidentTitle = canonicalOAuthAlarmTitle(title, payload);
  const incidentKey = [
    slugOAuthAlarmToken(team, 'hub'),
    slugOAuthAlarmToken(fromBot, 'hub-oauth-monitor'),
    slugOAuthAlarmToken(eventType, 'hub-oauth-monitor_error'),
    stableOAuthAlarmHash(incidentTitle.slice(0, 120)),
  ].join(':');
  const dedupeMinutes = Number.isFinite(Number(cooldownMs))
    ? Math.max(1, Math.ceil(Number(cooldownMs) / 60_000))
    : null;

  return {
    team,
    fromBot,
    alarmType,
    eventType,
    incidentKey,
    dedupeMinutes,
    visibility: manualReauth ? 'human_action' : alarmType === 'error' ? 'internal' : 'digest',
    actionability: manualReauth ? 'needs_human' : alarmType === 'error' ? 'auto_repair' : 'none',
  };
}

module.exports = {
  buildOAuthMonitorAlarmEnvelope,
  canonicalOAuthAlarmTitle,
  isOAuthManualReauth,
};
