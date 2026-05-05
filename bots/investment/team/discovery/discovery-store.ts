// @ts-nocheck
// candidate_universe 테이블 읽기/쓰기
// TTL 기반 동적 universe 관리 (기본 TTL: 24h)

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pgPool = require('../../../../packages/core/lib/pg-pool');
const { createSchemaDbHelpers } = require('../../../../packages/core/lib/db/helpers');
import type { DiscoveryMarket, DiscoverySignal } from './types.ts';

const db = createSchemaDbHelpers(pgPool, 'investment');

// candidate_universe 테이블 초기화 (없으면 생성)
export async function ensureCandidateUniverseTable(): Promise<void> {
  await db.run(`
    CREATE TABLE IF NOT EXISTS candidate_universe (
      id            BIGSERIAL     PRIMARY KEY,
      symbol        TEXT          NOT NULL,
      market        TEXT          NOT NULL CHECK (market IN ('domestic', 'overseas', 'crypto')),
      source        TEXT          NOT NULL,
      source_tier   INTEGER       NOT NULL DEFAULT 2 CHECK (source_tier IN (1, 2)),
      score         NUMERIC(5,4)  NOT NULL DEFAULT 0.5000,
      confidence    DOUBLE PRECISION DEFAULT 0.5,
      reason        TEXT,
      reason_code   TEXT,
      evidence_ref  JSONB         DEFAULT '{}'::jsonb,
      quality_flags JSONB         DEFAULT '[]'::jsonb,
      ttl_hours     INTEGER       DEFAULT 24,
      raw_data      JSONB         DEFAULT '{}'::jsonb,
      discovered_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      expires_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
      UNIQUE (symbol, market, source)
    )
  `);
  try { await db.run(`ALTER TABLE candidate_universe ADD COLUMN IF NOT EXISTS confidence DOUBLE PRECISION DEFAULT 0.5`); } catch {}
  try { await db.run(`ALTER TABLE candidate_universe ADD COLUMN IF NOT EXISTS reason_code TEXT`); } catch {}
  try { await db.run(`ALTER TABLE candidate_universe ADD COLUMN IF NOT EXISTS evidence_ref JSONB DEFAULT '{}'::jsonb`); } catch {}
  try { await db.run(`ALTER TABLE candidate_universe ADD COLUMN IF NOT EXISTS quality_flags JSONB DEFAULT '[]'::jsonb`); } catch {}
  try { await db.run(`ALTER TABLE candidate_universe ADD COLUMN IF NOT EXISTS ttl_hours INTEGER DEFAULT 24`); } catch {}
  try {
    await db.run(`CREATE INDEX IF NOT EXISTS idx_candidate_universe_market_score ON candidate_universe (market, score DESC) WHERE expires_at > NOW()`);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_candidate_universe_expires ON candidate_universe (expires_at)`);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_candidate_universe_source ON candidate_universe (source, market, discovered_at DESC)`);
  } catch { /* 인덱스 중복 무시 */ }
}

// 시그널 배치 upsert (ON CONFLICT → score/reason/raw_data/expires_at 갱신)
export async function upsertCandidateSignals(
  signals: DiscoverySignal[],
  market: DiscoveryMarket,
  source: string,
  sourceTier: 1 | 2,
  ttlHours = 24,
): Promise<{ inserted: number; updated: number }> {
  if (!signals || signals.length === 0) return { inserted: 0, updated: 0 };

  let inserted = 0;
  let updated = 0;

  for (const sig of signals) {
    const symbol = normalizeCandidateSymbolForMarket(sig.symbol, market);
    if (!symbol || typeof sig.score !== 'number') continue;
    const result = await db.get(`
      INSERT INTO candidate_universe
        (symbol, market, source, source_tier, score, confidence, reason, reason_code, evidence_ref, quality_flags, ttl_hours, raw_data, expires_at)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW() + ($13 || ' hours')::interval)
      ON CONFLICT (symbol, market, source) DO UPDATE SET
        score         = EXCLUDED.score,
        confidence    = EXCLUDED.confidence,
        reason        = EXCLUDED.reason,
        reason_code   = EXCLUDED.reason_code,
        evidence_ref  = EXCLUDED.evidence_ref,
        quality_flags = EXCLUDED.quality_flags,
        ttl_hours     = EXCLUDED.ttl_hours,
        raw_data      = EXCLUDED.raw_data,
        discovered_at = NOW(),
        expires_at    = NOW() + ($13 || ' hours')::interval
      RETURNING (xmax = 0) AS inserted
    `, [
      symbol,
      market,
      source,
      sourceTier,
      Math.min(1, Math.max(0, sig.score)),
      Math.min(1, Math.max(0, Number(sig.confidence ?? sig.score ?? 0.5))),
      sig.reason || null,
      sig.reasonCode || null,
      sig.evidenceRef ? JSON.stringify(sig.evidenceRef) : '{}',
      JSON.stringify(Array.isArray(sig.qualityFlags) ? sig.qualityFlags : []),
      Math.max(1, Number(sig.ttlHours || ttlHours || 24)),
      sig.raw ? JSON.stringify(sig.raw) : '{}',
      String(ttlHours),
    ]);
    if (result?.inserted === true) inserted++;
    else updated++;
  }

  return { inserted, updated };
}

function normalizeCandidateSymbolForMarket(symbol: string, market: DiscoveryMarket): string | null {
  const raw = String(symbol || '').trim().toUpperCase();
  if (!raw) return null;
  if (market === 'crypto') {
    if (/^[A-Z0-9]+\/USDT$/.test(raw)) return raw;
    if (/^[A-Z0-9]+USDT$/.test(raw) && raw.length > 6) return `${raw.slice(0, -4)}/USDT`;
    return null;
  }
  if (market === 'domestic') {
    return /^\d{6}$/.test(raw) ? raw : null;
  }
  if (raw.includes('/') || /^\d{6}$/.test(raw)) return null;
  return /^[A-Z][A-Z0-9.\-]{0,12}$/.test(raw) ? raw : null;
}

// 활성 universe 조회 (expires_at 기준 필터링)
export async function getActiveCandidates(
  market: DiscoveryMarket,
  limit = 150,
): Promise<Array<{ symbol: string; market: string; source: string; score: number; reason: string }>> {
  return db.query(`
    SELECT symbol,
           market,
           source,
           source_tier,
           score::float AS score,
           confidence,
           reason,
           reason_code,
           evidence_ref,
           quality_flags,
           discovered_at,
           expires_at
    FROM candidate_universe
    WHERE market = $1
      AND expires_at > NOW()
    ORDER BY score DESC
    LIMIT $2
  `, [market, limit]);
}

// 소스별 최신 수집 시각 (staleness 모니터링용)
export async function getSourceLastFetch(
  source: string,
  market: DiscoveryMarket,
): Promise<Date | null> {
  const row = await db.get(`
    SELECT MAX(discovered_at) AS last_fetch
    FROM candidate_universe
    WHERE source = $1 AND market = $2
  `, [source, market]);
  return row?.last_fetch ? new Date(row.last_fetch) : null;
}

// 만료된 후보 정리 (주기적 호출 권장)
export async function purgeExpiredCandidates(): Promise<number> {
  const result = await db.run(`
    DELETE FROM candidate_universe
    WHERE expires_at <= NOW()
  `);
  return result.rowCount || 0;
}

// 시장별 후보 수 집계 (헬스 모니터용)
export async function getCandidateStats(): Promise<Record<DiscoveryMarket, { total: number; sources: string[] }>> {
  const rows = await db.query(`
    SELECT market, source, COUNT(*) AS cnt
    FROM candidate_universe
    WHERE expires_at > NOW()
    GROUP BY market, source
    ORDER BY market, cnt DESC
  `);

  const stats: Record<string, { total: number; sources: string[] }> = {
    domestic: { total: 0, sources: [] },
    overseas: { total: 0, sources: [] },
    crypto:   { total: 0, sources: [] },
  };

  for (const row of rows) {
    const m = row.market as DiscoveryMarket;
    if (stats[m]) {
      stats[m].total += Number(row.cnt);
      stats[m].sources.push(row.source);
    }
  }

  return stats;
}
