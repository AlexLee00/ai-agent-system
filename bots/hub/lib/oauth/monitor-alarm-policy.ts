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
  const incidentKey = [
    slugOAuthAlarmToken(team, 'hub'),
    slugOAuthAlarmToken(fromBot, 'hub-oauth-monitor'),
    slugOAuthAlarmToken(eventType, 'hub-oauth-monitor_error'),
    stableOAuthAlarmHash(String(title || 'oauth_alarm').trim().slice(0, 120)),
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
    visibility: alarmType === 'error' ? 'internal' : 'digest',
    actionability: alarmType === 'error' ? 'auto_repair' : 'none',
  };
}

module.exports = {
  buildOAuthMonitorAlarmEnvelope,
};
