// @ts-nocheck
import crypto from 'crypto';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const path = require('path');
const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..');
const pgPool = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool'));

function envTtlMs(name: string, fallback: number): number {
  const value = Number(process.env[name] || 0);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

const TTL_MAP: Record<string, number> = {
  realtime: 24 * 60 * 60 * 1000,
  sentiment_realtime: envTtlMs('HUB_LLM_CACHE_SENTIMENT_TTL_MS', 45 * 60 * 1000),
  analysis: 7 * 24 * 60 * 60 * 1000,
  research: 30 * 24 * 60 * 60 * 1000,
  default: 24 * 60 * 60 * 1000,
};

export interface CacheKey {
  abstractModel: string;
  prompt: string;
  systemPrompt?: string;
  callerTeam?: string;
  agent?: string;
  taskType?: string;
  selectorKey?: string;
  jsonSchema?: unknown;
  maxTokens?: number | null;
  temperature?: number | null;
}

export interface CacheCheckResult {
  hit: boolean;
  response?: string;
  tokens?: { in: number; out: number };
  costUsd?: number;
  cachedAt?: Date;
}

export function computeHash(key: CacheKey): string {
  const raw = JSON.stringify({
    abstractModel: key.abstractModel,
    callerTeam: key.callerTeam || null,
    agent: key.agent || null,
    taskType: key.taskType || null,
    selectorKey: key.selectorKey || null,
    systemPrompt: key.systemPrompt || '',
    prompt: key.prompt || '',
    jsonSchema: key.jsonSchema || null,
    maxTokens: key.maxTokens ?? null,
    temperature: key.temperature ?? null,
  });
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export async function checkCache(key: CacheKey): Promise<CacheCheckResult> {
  if (!cacheEnabled()) return { hit: false };

  const hash = computeHash(key);
  try {
    const rows = await pgPool.query(
      'public',
      `UPDATE llm_cache
       SET hit_count = hit_count + 1, last_hit_at = NOW()
       WHERE prompt_hash = $1 AND expires_at > NOW()
       RETURNING response, tokens_in, tokens_out, cost_usd, inserted_at`,
      [hash]
    );

    if (rows.length === 0) return { hit: false };

    const row = rows[0];
    return {
      hit: true,
      response: row.response,
      tokens: { in: row.tokens_in || 0, out: row.tokens_out || 0 },
      costUsd: Number(row.cost_usd) || 0,
      cachedAt: row.inserted_at,
    };
  } catch (e: any) {
    console.warn('[llm/cache] checkCache 오류 (무시):', e.message);
    return { hit: false };
  }
}

export async function saveCache(
  key: CacheKey,
  response: string,
  tokens: { in: number; out: number },
  costUsd: number,
  cacheType: string = 'default'
): Promise<void> {
  if (!cacheEnabled()) return;

  const hash = computeHash(key);
  const ttlMs = TTL_MAP[cacheType] ?? TTL_MAP.default;
  const expiresAt = new Date(Date.now() + ttlMs);

  try {
    await pgPool.run(
      'public',
      `INSERT INTO llm_cache
         (prompt_hash, abstract_model, response, tokens_in, tokens_out, cost_usd, cache_type, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (prompt_hash) DO UPDATE SET
         response = EXCLUDED.response,
         tokens_in = EXCLUDED.tokens_in,
         tokens_out = EXCLUDED.tokens_out,
         cost_usd = EXCLUDED.cost_usd,
         cache_type = EXCLUDED.cache_type,
         expires_at = EXCLUDED.expires_at,
         hit_count = llm_cache.hit_count`,
      [hash, key.abstractModel, response, tokens.in, tokens.out, costUsd, cacheType, expiresAt]
    );
  } catch (e: any) {
    console.warn('[llm/cache] saveCache 오류 (무시):', e.message);
  }
}

export async function cleanupExpiredCache(): Promise<number> {
  try {
    const result = await pgPool.run(
      'public',
      `DELETE FROM llm_cache WHERE expires_at < NOW() RETURNING id`
    );
    return result.rowCount || 0;
  } catch (e: any) {
    console.warn('[llm/cache] cleanupExpiredCache 오류:', e.message);
    return 0;
  }
}

export function cacheEnabled(): boolean {
  return process.env.HUB_LLM_CACHE_ENABLED === 'true';
}
