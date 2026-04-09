import crypto = require('crypto');
import kst = require('./kst');
import pgPool = require('./pg-pool');
import env = require('./env');

type CacheRow = {
  id: number;
  response: string;
  model: string;
  hit_count: number | string;
};

type CacheStatsRow = {
  team: string;
  total_entries: number;
  total_hits: number;
  avg_ttl: number;
};

const DEV_HUB_READONLY = env.IS_DEV && !!env.HUB_BASE_URL && !process.env.PG_DIRECT;

let initialized = false;

async function ensureTable(): Promise<void> {
  if (initialized) return;
  if (DEV_HUB_READONLY) {
    initialized = true;
    return;
  }
  await pgPool.run('reservation', `
    CREATE TABLE IF NOT EXISTS llm_cache (
      id              SERIAL PRIMARY KEY,
      cache_key       TEXT    NOT NULL,
      team            TEXT    NOT NULL,
      request_type    TEXT,
      request_summary TEXT,
      response        TEXT    NOT NULL,
      model           TEXT    NOT NULL,
      hit_count       INTEGER DEFAULT 0,
      ttl_minutes     INTEGER NOT NULL,
      created_at      TEXT    NOT NULL,
      expires_at      TEXT    NOT NULL,
      UNIQUE (cache_key, team)
    )
  `);
  await pgPool.run('reservation', `
    CREATE INDEX IF NOT EXISTS idx_cache_expires ON llm_cache(expires_at)
  `);
  initialized = true;
}

const TTL_CONFIG: Record<string, number> = {
  ska: 30,
  claude: 360,
  luna: 5,
};

const STOP_WORDS = new Set([
  '이', '그', '저', '은', '는', '가', '을', '를', '의', '에', '에서',
  '와', '과', '도', '로', '으로', '하다', '있다', '없다', '되다', '이다',
  '것', '수', '때', '더', '또', '및', '등', '해', '됩니다', '합니다',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
  'have', 'has', 'do', 'does', 'in', 'on', 'at', 'to', 'for',
  'of', 'and', 'or', 'but', 'with', 'this', 'that', 'it',
]);

function kstNow(): string {
  return kst.datetimeStr();
}

function extractKeywords(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\s가-힣]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .sort()
    .slice(0, 30)
    .join(' ');
}

function generateCacheKey(team: string, requestType: string, input: string): string {
  const keywords = extractKeywords(input);
  const raw = `${team}:${requestType || 'unknown'}:${keywords}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function getCached(
  team: string,
  requestType: string,
  input: string,
): Promise<{ response: string; model: string; hitCount: number } | null> {
  try {
    await ensureTable();
    const key = generateCacheKey(team, requestType, input);
    const now = kstNow();

    const row = await pgPool.get<CacheRow>('reservation', `
      SELECT id, response, model, hit_count
      FROM llm_cache
      WHERE cache_key = $1 AND team = $2 AND expires_at > $3
    `, [key, team, now]);

    if (!row) return null;

    if (!DEV_HUB_READONLY) {
      await pgPool.run('reservation', `
        UPDATE llm_cache SET hit_count = hit_count + 1 WHERE id = $1
      `, [row.id]);
    }

    return {
      response: row.response,
      model: row.model,
      hitCount: parseInt(String(row.hit_count), 10) + 1,
    };
  } catch {
    return null;
  }
}

async function setCache(
  team: string,
  requestType: string,
  input: string,
  response: unknown,
  model: string,
): Promise<void> {
  if (DEV_HUB_READONLY) return;
  try {
    await ensureTable();
    const key = generateCacheKey(team, requestType, input);
    const ttl = TTL_CONFIG[team] || 30;
    const now = new Date();
    const nowStr = now.toISOString().replace('Z', '+09:00');
    const expires = new Date(now.getTime() + ttl * 60 * 1000).toISOString().replace('Z', '+09:00');

    const summary = String(input || '').slice(0, 100).replace(/\d{6,}/g, '***');
    const respStr = typeof response === 'string' ? response : JSON.stringify(response);

    await pgPool.run('reservation', `
      INSERT INTO llm_cache
        (cache_key, team, request_type, request_summary, response, model,
         hit_count, ttl_minutes, created_at, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,$9)
      ON CONFLICT (cache_key, team) DO UPDATE SET
        response        = EXCLUDED.response,
        model           = EXCLUDED.model,
        request_summary = EXCLUDED.request_summary,
        ttl_minutes     = EXCLUDED.ttl_minutes,
        created_at      = EXCLUDED.created_at,
        expires_at      = EXCLUDED.expires_at,
        hit_count       = 0
    `, [key, team, requestType, summary, respStr, model, ttl, nowStr, expires]);
  } catch (error) {
    const err = error as Error;
    console.warn('[llm-cache] 캐시 저장 실패 (메인 로직에 영향 없음):', err.message);
  }
}

async function getCacheStats(days = 7): Promise<CacheStatsRow[]> {
  await ensureTable();
  const cutoff = new Date(Date.now() + 9 * 3600 * 1000 - days * 86400 * 1000)
    .toISOString()
    .replace('Z', '+09:00');

  return pgPool.query<CacheStatsRow>('reservation', `
    SELECT team,
           COUNT(*)::integer        AS total_entries,
           SUM(hit_count)::integer  AS total_hits,
           AVG(ttl_minutes)::float  AS avg_ttl
    FROM llm_cache
    WHERE created_at >= $1
    GROUP BY team
    ORDER BY total_hits DESC
  `, [cutoff]);
}

async function cleanExpired(): Promise<number> {
  if (DEV_HUB_READONLY) return 0;
  try {
    await ensureTable();
    const result = await pgPool.run('reservation', `
      DELETE FROM llm_cache WHERE expires_at <= $1
    `, [kstNow()]) as { rowCount?: number };
    return result.rowCount || 0;
  } catch {
    return 0;
  }
}

export = {
  generateCacheKey,
  getCached,
  setCache,
  getCacheStats,
  cleanExpired,
  TTL_CONFIG,
};
