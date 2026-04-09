'use strict';

const pgPool = require('../../../packages/core/lib/pg-pool') as {
  run: (
    schema: string,
    query: string,
    params?: unknown[]
  ) => Promise<{ rowCount?: number }>;
  get: (
    schema: string,
    query: string,
    params?: unknown[]
  ) => Promise<unknown | null>;
  query: (
    schema: string,
    query: string,
    params?: unknown[]
  ) => Promise<unknown[]>;
};

const SCHEMA = 'claude';
const EVENT_PREFIX = 'event:';

async function setMute(target: string, durationMs: number, reason = ''): Promise<string> {
  const until = new Date(Date.now() + durationMs).toISOString();
  await pgPool.run(SCHEMA, 'DELETE FROM mute_settings WHERE target = $1', [target]);
  await pgPool.run(
    SCHEMA,
    `
    INSERT INTO mute_settings (target, mute_until, reason) VALUES ($1, $2, $3)
  `,
    [target, until, reason]
  );
  return until;
}

async function clearMute(target: string): Promise<void> {
  await pgPool.run(SCHEMA, 'DELETE FROM mute_settings WHERE target = $1', [target]);
}

async function isMuted(target: string): Promise<boolean> {
  const now = new Date().toISOString();
  const row = await pgPool.get(
    SCHEMA,
    `
    SELECT 1 FROM mute_settings
    WHERE target = $1 AND mute_until > $2
    LIMIT 1
  `,
    [target, now]
  );
  return Boolean(row);
}

async function isAlertMuted(botName: string, teamName: string): Promise<boolean> {
  const [allMuted, teamMuted, botMuted] = await Promise.all([
    isMuted('all'),
    isMuted(teamName),
    isMuted(botName),
  ]);
  return allMuted || teamMuted || botMuted;
}

async function setMuteByEvent(
  fromBot: string,
  eventType: string,
  durationMs: number,
  reason = ''
): Promise<string> {
  return setMute(`${EVENT_PREFIX}${fromBot}:${eventType}`, durationMs, reason);
}

async function isEventMuted(fromBot: string, eventType: string): Promise<boolean> {
  if (!fromBot || !eventType) {
    return false;
  }
  return isMuted(`${EVENT_PREFIX}${fromBot}:${eventType}`);
}

async function clearMuteByEvent(fromBot: string, eventType: string): Promise<void> {
  await clearMute(`${EVENT_PREFIX}${fromBot}:${eventType}`);
}

async function listMutes(): Promise<unknown[]> {
  const now = new Date().toISOString();
  return pgPool.query(
    SCHEMA,
    `
    SELECT target, mute_until, reason
    FROM mute_settings
    WHERE mute_until > $1
    ORDER BY mute_until ASC
  `,
    [now]
  );
}

async function cleanExpired(): Promise<number> {
  const now = new Date().toISOString();
  const result = await pgPool.run(
    SCHEMA,
    'DELETE FROM mute_settings WHERE mute_until <= $1',
    [now]
  );
  return result.rowCount || 0;
}

function parseDuration(duration: string): { ms: number; label: string } | null {
  const match = String(duration || '').match(/^(\d+)(m|h|d)$/i);
  if (!match) {
    return null;
  }

  const [, n, unitRaw] = match;
  const unit = unitRaw.toLowerCase();
  const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  const unitLabel = { m: '분', h: '시간', d: '일' }[unit];

  if (!unitMs || !unitLabel) {
    return null;
  }

  return {
    ms: parseInt(n, 10) * unitMs,
    label: `${n}${unitLabel}`,
  };
}

module.exports = {
  cleanExpired,
  clearMute,
  clearMuteByEvent,
  isAlertMuted,
  isEventMuted,
  isMuted,
  listMutes,
  parseDuration,
  setMute,
  setMuteByEvent,
};
