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
};

const SCHEMA = 'claude';
const CONFIRM_TTL_MS = 10 * 60 * 1000;

let ensureTablePromise: Promise<void> | null = null;

function isMissingPendingConfirmsError(error: unknown): boolean {
  const err = error as { code?: string; message?: string };
  return err?.code === '42P01' || /pending_confirms/i.test(String(err?.message || ''));
}

async function ensurePendingConfirmsTable(): Promise<void> {
  if (ensureTablePromise) return ensureTablePromise;
  ensureTablePromise = (async () => {
    await pgPool.run(
      SCHEMA,
      `CREATE TABLE IF NOT EXISTS pending_confirms (
        id          BIGSERIAL    PRIMARY KEY,
        queue_id    TEXT         NOT NULL,
        confirm_key TEXT         NOT NULL UNIQUE,
        type        TEXT         NOT NULL DEFAULT 'mainbot_confirm',
        payload     JSONB        NOT NULL DEFAULT '{}'::jsonb,
        message     TEXT         NOT NULL DEFAULT '',
        status      TEXT         NOT NULL DEFAULT 'pending',
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        expires_at  TIMESTAMPTZ  NOT NULL,
        resolved_at TIMESTAMPTZ
      )`,
      [],
    );
    await pgPool.run(
      SCHEMA,
      `ALTER TABLE pending_confirms
       ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'mainbot_confirm'`,
      [],
    );
    await pgPool.run(
      SCHEMA,
      `ALTER TABLE pending_confirms
       ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb`,
      [],
    );
    await pgPool.run(
      SCHEMA,
      `ALTER TABLE pending_confirms
       ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      [],
    );
    await pgPool.run(
      SCHEMA,
      `ALTER TABLE pending_confirms
       ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      [],
    );
    await pgPool.run(
      SCHEMA,
      `CREATE INDEX IF NOT EXISTS idx_pending_confirms_status_exp
       ON pending_confirms (status, expires_at) WHERE status = 'pending'`,
      [],
    );
    await pgPool.run(
      SCHEMA,
      `CREATE INDEX IF NOT EXISTS idx_pending_confirms_type_status_exp
       ON pending_confirms (type, status, expires_at) WHERE status = 'pending'`,
      [],
    );
    await pgPool.run(
      SCHEMA,
      `CREATE INDEX IF NOT EXISTS idx_pending_confirms_queue
       ON pending_confirms (queue_id, status)`,
      [],
    );
  })().catch((error) => {
    ensureTablePromise = null;
    throw error;
  });
  return ensureTablePromise;
}

async function createConfirm(
  queueId: string | number,
  message: string
): Promise<{ confirmKey: string; rejectKey: string; expiresAt: string }> {
  await ensurePendingConfirmsTable();
  const expiresAt = new Date(Date.now() + CONFIRM_TTL_MS).toISOString();
  const now = Date.now();
  const confirmKey = `yes_${queueId}_${now}`;
  const rejectKey = `no_${queueId}_${now}`;

  await pgPool.run(
    SCHEMA,
    `
    INSERT INTO pending_confirms (queue_id, confirm_key, type, payload, message, expires_at, created_at, updated_at)
    VALUES ($1, $2, 'mainbot_confirm', $3::jsonb, $4, $5, NOW(), NOW())
  `,
    [queueId, confirmKey, JSON.stringify({ action: 'approve', queueId }), message, expiresAt]
  );

  await pgPool.run(
    SCHEMA,
    `
    INSERT INTO pending_confirms (queue_id, confirm_key, type, payload, message, expires_at, created_at, updated_at)
    VALUES ($1, $2, 'mainbot_confirm', $3::jsonb, $4, $5, NOW(), NOW())
  `,
    [queueId, rejectKey, JSON.stringify({ action: 'reject', queueId }), message, expiresAt]
  );

  return { confirmKey, rejectKey, expiresAt };
}

async function getByKey(key: string): Promise<unknown | null> {
  await ensurePendingConfirmsTable();
  return pgPool.get(
    SCHEMA,
    `
    SELECT * FROM pending_confirms WHERE confirm_key = $1 AND status = 'pending'
  `,
    [key]
  );
}

async function resolve(key: string, action: string): Promise<boolean> {
  await ensurePendingConfirmsTable();
  const now = new Date().toISOString();
  const result = await pgPool.run(
    SCHEMA,
    `
    UPDATE pending_confirms
    SET status = $1, resolved_at = $2, updated_at = $2
    WHERE confirm_key = $3 AND status = 'pending' AND expires_at > $2
  `,
    [action, now, key]
  );
  return (result.rowCount || 0) > 0;
}

async function cleanExpired(): Promise<number> {
  const now = new Date().toISOString();
  try {
    await ensurePendingConfirmsTable();
    const result = await pgPool.run(
      SCHEMA,
      `
      UPDATE pending_confirms SET status = 'expired', updated_at = $1
      WHERE status = 'pending' AND expires_at <= $1
    `,
      [now]
    );
    return result.rowCount || 0;
  } catch (error) {
    if (!isMissingPendingConfirmsError(error)) throw error;
    ensureTablePromise = null;
    await ensurePendingConfirmsTable();
    const retry = await pgPool.run(
      SCHEMA,
      `
      UPDATE pending_confirms SET status = 'expired', updated_at = $1
      WHERE status = 'pending' AND expires_at <= $1
    `,
      [now]
    );
    return retry.rowCount || 0;
  }
}

module.exports = { cleanExpired, createConfirm, getByKey, resolve, ensurePendingConfirmsTable };
