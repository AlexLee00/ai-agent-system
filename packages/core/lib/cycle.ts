const pgPool = require('./pg-pool');
const eventLake = require('./event-lake');

const SCHEMA = 'agent';
const TABLE = `${SCHEMA}.event_lake`;
const FALLBACK_BASE_CYCLE_ID = 42;

let _indexPromise: Promise<void> | null = null;

function asInt(value: unknown, fallback: number | null = null): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
}

export async function ensureCycleIndex() {
  if (_indexPromise) return _indexPromise;
  _indexPromise = (async () => {
    if (typeof eventLake.initSchema === 'function') {
      await eventLake.initSchema();
    }
    await pgPool.run(SCHEMA, `
      CREATE INDEX IF NOT EXISTS idx_event_lake_cycle_id
      ON ${TABLE} ((metadata->>'cycle_id'))
    `, []);
  })().catch((error: Error) => {
    _indexPromise = null;
    throw error;
  });
  return _indexPromise;
}

export async function getCurrentCycleId(): Promise<number | null> {
  await ensureCycleIndex();
  const row = await pgPool.get(SCHEMA, `
    SELECT (metadata->>'cycle_id')::int AS cycle_id
    FROM ${TABLE}
    WHERE event_type LIKE 'master.intervention.%'
      AND metadata->>'cycle_id' IS NOT NULL
      AND metadata->>'cycle_id' ~ '^[0-9]+$'
    ORDER BY created_at DESC
    LIMIT 1
  `, []);
  return asInt(row?.cycle_id, null);
}

export async function getNextCycleId(): Promise<number> {
  await ensureCycleIndex();
  const row = await pgPool.get(SCHEMA, `
    SELECT COALESCE(MAX((metadata->>'cycle_id')::int), $1::int) + 1 AS cycle_id
    FROM ${TABLE}
    WHERE metadata->>'cycle_id' IS NOT NULL
      AND metadata->>'cycle_id' ~ '^[0-9]+$'
  `, [FALLBACK_BASE_CYCLE_ID]);
  return asInt(row?.cycle_id, FALLBACK_BASE_CYCLE_ID + 1) || FALLBACK_BASE_CYCLE_ID + 1;
}

export default {
  ensureCycleIndex,
  getCurrentCycleId,
  getNextCycleId,
};
