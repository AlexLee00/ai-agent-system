import os from 'node:os';
import { Pool } from 'pg';
import env = require('./env');

type PoolStats = {
  schema: string;
  total: number;
  idle: number;
  waiting: number;
  active: number;
  utilization: string;
};

type ReconnectState = {
  timer: NodeJS.Timeout | null;
  attempts: number;
};

type PgPoolLike = InstanceType<typeof Pool>;

const PG_CONFIG = {
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  user: process.env.PG_USER || os.userInfo().username,
  password: process.env.PG_PASSWORD || undefined,
  database: process.env.PG_DATABASE || 'jay',
  max: parseInt(
    process.env.PG_POOL_MAX
      || (env.IS_OPS || env.IS_CLI ? '2' : '4'),
    10,
  ),
  idleTimeoutMillis: parseInt(
    process.env.PG_IDLE_TIMEOUT_MS
      || (env.IS_OPS || env.IS_CLI ? '5000' : '15000'),
    10,
  ),
  allowExitOnIdle: true,
  connectionTimeoutMillis: 5000,
};

const VALID_SCHEMAS = new Set(['claude', 'reservation', 'investment', 'ska', 'worker', 'blog', 'agent', 'sigma', 'rag', 'public']);
const pools = new Map<string, PgPoolLike>();

const MAX_RECONNECT_ATTEMPTS = 10;
const reconnectState = new Map<string, ReconnectState>();
const RECONNECT_CODES = new Set(['ECONNREFUSED', '57P01', 'ECONNRESET', 'EPIPE']);
const RECONNECT_MESSAGES = ['connection terminated', 'connection destroyed', 'server closed the connection'];

const useHub = !env.IS_OPS && !env.IS_CLI && !!env.HUB_BASE_URL && !process.env.PG_DIRECT;

function isReadOnlySql(sql: string): boolean {
  const normalized = String(sql || '').trim().toLowerCase();
  if (!normalized) return false;
  return normalized.startsWith('select')
    || normalized.startsWith('with')
    || normalized.startsWith('explain');
}

function isConnError(err: any): boolean {
  if (!err) return false;
  return RECONNECT_CODES.has(err.code) || RECONNECT_MESSAGES.some((message) => err.message?.includes(message));
}

function snapshotPoolStats(pool: PgPoolLike | null | undefined, schema = 'unknown'): PoolStats {
  if (!pool) {
    return { schema, total: 0, idle: 0, waiting: 0, active: 0, utilization: '0%' };
  }
  const active = pool.totalCount - pool.idleCount;
  return {
    schema,
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
    active,
    utilization: pool.totalCount > 0 ? `${((active / pool.totalCount) * 100).toFixed(1)}%` : '0%',
  };
}

function scheduleReconnect(schema: string, pool: PgPoolLike): void {
  const state = reconnectState.get(schema) || { timer: null, attempts: 0 };
  if (state.timer) return;

  const delay = Math.min(1000 * Math.pow(2, state.attempts), 30000);
  console.warn(`[pg-pool:${schema}] ${delay / 1000}초 후 재연결 시도 (${state.attempts + 1}/${MAX_RECONNECT_ATTEMPTS})`);

  state.timer = setTimeout(async () => {
    state.timer = null;
    try {
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      console.log(`[pg-pool:${schema}] ✅ 재연결 성공`);
      state.attempts = 0;
      reconnectState.set(schema, state);
    } catch {
      state.attempts += 1;
      reconnectState.set(schema, state);
      if (state.attempts < MAX_RECONNECT_ATTEMPTS) {
        scheduleReconnect(schema, pool);
      } else {
        console.error(`[pg-pool:${schema}] ❌ 재연결 최대 시도 초과 (${MAX_RECONNECT_ATTEMPTS}회) — 이후 자동 재시도 중단`);
        state.attempts = 0;
        reconnectState.set(schema, state);
      }
    }
  }, delay);
  reconnectState.set(schema, state);
}

export function parameterize(sql: string): string {
  if (!sql || !sql.includes('?')) return sql;
  let idx = 0;
  return sql.replace(/\?/g, () => `$${++idx}`);
}

export function getPool(schema: string): PgPoolLike {
  if (!VALID_SCHEMAS.has(schema)) {
    throw new Error(`[pg-pool] 유효하지 않은 스키마: ${schema}`);
  }
  if (!/^[a-z_]+$/.test(schema)) {
    throw new Error(`[pg-pool] 스키마명 형식 오류: ${schema}`);
  }
  if (pools.has(schema)) return pools.get(schema) as PgPoolLike;

  const pool = new Pool({
    ...PG_CONFIG,
    options: `-c search_path=${schema},public`,
  });

  pool.on('error', (err: any) => {
    console.error(`[pg-pool:${schema}] 커넥션 오류:`, err.message);
    if (isConnError(err)) {
      console.warn(`[pg-pool:${schema}] PostgreSQL 연결 끊김 감지 — 재연결 예약`);
      scheduleReconnect(schema, pool);
    }
  });

  pools.set(schema, pool);
  return pool;
}

async function safeQuery(pool: PgPoolLike, sql: string, params: any[]): Promise<any> {
  const MAX_ATTEMPTS = 3;
  let lastErr: any;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return await pool.query(sql, params);
    } catch (error) {
      lastErr = error;
      const schema = pool?.options?.options?.match(/search_path=([^,]+)/)?.[1] || 'unknown';
      const stats = snapshotPoolStats(pool, schema);
      if (!isConnError(error)) throw error;
      if (attempt < MAX_ATTEMPTS - 1) {
        const wait = 1000 * (attempt + 1);
        console.warn(`[pg-pool:${schema}] 쿼리 재시도 ${attempt + 1}/${MAX_ATTEMPTS} (${wait}ms 대기): ${(error as Error).message} | pool=${JSON.stringify(stats)}`);
        await new Promise((resolve) => setTimeout(resolve, wait));
      } else {
        console.error(`[pg-pool:${schema}] 쿼리 최종 실패: ${(error as Error).message} | pool=${JSON.stringify(stats)} | sql=${String(sql).slice(0, 140)}`);
      }
    }
  }
  throw lastErr;
}

async function queryViaHub(schema: string, sql: string, params: any[] = []): Promise<{ rows: any[]; rowCount: number }> {
  const { queryOpsDb } = require('./hub-client.js') as { queryOpsDb: (sql: string, schema: string, params: any[]) => Promise<any> };
  const result = await queryOpsDb(parameterize(sql), schema, params);
  if (!result) return { rows: [], rowCount: 0 };
  return { rows: result.rows || [], rowCount: result.rowCount || 0 };
}

export async function query<T = any>(schema: string, sql: string, params: any[] = []): Promise<T[]> {
  if (useHub && isReadOnlySql(sql)) {
    const result = await queryViaHub(schema, sql, params);
    return result.rows as T[];
  }
  const pool = getPool(schema);
  const result = await safeQuery(pool, parameterize(sql), params);
  return result.rows as T[];
}

export async function run(schema: string, sql: string, params: any[] = []): Promise<{ rowCount: number; rows: any[] }> {
  if (useHub && isReadOnlySql(sql)) return queryViaHub(schema, sql, params);
  const pool = getPool(schema);
  const result = await safeQuery(pool, parameterize(sql), params);
  return { rowCount: result.rowCount, rows: result.rows };
}

export async function get<T = any>(schema: string, sql: string, params: any[] = []): Promise<T | null> {
  const rows = await query<T>(schema, sql, params);
  return rows[0] || null;
}

export function prepare(schema: string, sql: string): { get: (...args: any[]) => Promise<any>; all: (...args: any[]) => Promise<any[]>; run: (...args: any[]) => Promise<{ rowCount: number; rows: any[] }> } {
  const normalized = parameterize(sql);
  return {
    get: (...args: any[]) => get(schema, normalized, args.flat()),
    all: (...args: any[]) => query(schema, normalized, args.flat()),
    run: (...args: any[]) => run(schema, normalized, args.flat()),
  };
}

export async function transaction<T = any>(schema: string, fn: (client: any) => Promise<T>): Promise<T> {
  const pool = getPool(schema);
  const client = await pool.connect();
  try {
    await client.query(`SET search_path = ${schema}, public`);
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function ping(schema = 'public'): Promise<boolean> {
  try {
    const rows = await query<{ ok: number }>(schema, 'SELECT 1 AS ok');
    return rows[0]?.ok === 1;
  } catch {
    return false;
  }
}

export async function closeAll(): Promise<void> {
  for (const [schema, pool] of pools) {
    try {
      await pool.end();
    } catch {
      // ignore
    }
    pools.delete(schema);
  }
}

export function getPoolStats(schema?: string): Record<string, PoolStats> | PoolStats | null {
  if (schema) {
    const pool = pools.get(schema);
    if (!pool) return null;
    return snapshotPoolStats(pool, schema);
  }
  const all: Record<string, PoolStats> = {};
  for (const [key, pool] of pools) {
    all[key] = snapshotPoolStats(pool, key);
  }
  return all;
}

export function getAllPoolStats(): PoolStats[] {
  const result: PoolStats[] = [];
  for (const [schema, pool] of pools) {
    result.push(snapshotPoolStats(pool, schema));
  }
  return result;
}

export function checkPoolHealth(threshold = 0.8): { stats: PoolStats[]; issues: Array<{ schema: string; status: string; detail: string }> } {
  const stats = getAllPoolStats();
  const issues: Array<{ schema: string; status: string; detail: string }> = [];
  const maxPool = PG_CONFIG.max;
  for (const stat of stats) {
    if (stat.total >= maxPool * threshold) {
      issues.push({
        schema: stat.schema,
        status: 'warning',
        detail: `커넥션 ${stat.total}/${maxPool} (${stat.utilization} 사용)`,
      });
    }
    if (stat.waiting > 5) {
      issues.push({
        schema: stat.schema,
        status: 'warning',
        detail: `대기 쿼리 ${stat.waiting}건 — 풀 부족 가능`,
      });
    }
  }
  return { stats, issues };
}

export async function getClient(schema: string): Promise<any> {
  const pool = getPool(schema);
  const client = await pool.connect();
  await client.query(`SET search_path = ${schema}, public`);
  return client;
}

const monitorTimer = setInterval(() => {
  for (const [schema, pool] of pools) {
    const total = pool.totalCount;
    if (total > 0) {
      const active = total - pool.idleCount;
      const highUtilization = active / total > 0.8;
      const shouldWarn = highUtilization && (total >= 3 || pool.waitingCount > 0 || active >= 2);
      if (shouldWarn) {
        console.warn(`[pg-pool:${schema}] ⚠️ 커넥션 풀 80%+ 사용: ${active}/${total} (대기: ${pool.waitingCount})`);
      }
    }
  }
}, 60000);
monitorTimer.unref();

let closing = false;
async function gracefulClose(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`[pg-pool] ${signal} 수신 — 커넥션 풀 종료`);
  await closeAll().catch(() => {});
}

process.on('SIGTERM', () => { gracefulClose('SIGTERM').catch(() => {}); });
process.on('SIGINT', () => { gracefulClose('SIGINT').catch(() => {}); });
