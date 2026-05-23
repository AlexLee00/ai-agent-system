// @ts-nocheck
// OpenDART/KRX 기반 factor 로그에서 국내 우량 후보를 discovery universe로 공급한다.

import type { DiscoveryAdapter, DiscoveryCollectOptions, DiscoveryResult, DiscoverySignal } from '../types.ts';
import { query } from '../../../shared/db.ts';
import { loadLunaCandidateQualityCooldownSymbols } from '../../../shared/luna-candidate-quality-governance.ts';

const SOURCE = 'korea_public_data_quality';

function round(value: any, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(digits));
}

function clamp01(value: any, fallback = 0.5) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

async function cooldownSymbolSet() {
  const rows = await loadLunaCandidateQualityCooldownSymbols({ market: 'domestic' }).catch(() => []);
  return new Set((rows || []).map((row) => row.symbol));
}

function mockSignals(): DiscoverySignal[] {
  return [
    {
      symbol: '005930',
      score: 0.79,
      confidence: 0.74,
      reason: 'OpenDART/Factor mock: quality/value candidate',
      reasonCode: 'korea_public_data_quality',
      qualityFlags: ['dry_run', 'korea_public_data_factor'],
      raw: { composite: 0.79, source: SOURCE },
    },
    {
      symbol: '000660',
      score: 0.76,
      confidence: 0.71,
      reason: 'OpenDART/Factor mock: quality/growth candidate',
      reasonCode: 'korea_public_data_quality',
      qualityFlags: ['dry_run', 'korea_public_data_factor'],
      raw: { composite: 0.76, source: SOURCE },
    },
  ];
}

function mkResult(fetchedAt: string, signals: DiscoverySignal[], status: 'ready' | 'degraded' | 'insufficient'): DiscoveryResult {
  return {
    source: SOURCE,
    market: 'domestic',
    fetchedAt,
    signals,
    quality: { status, sourceTier: 1, signalCount: signals.length },
  };
}

export class KoreaPublicDataQualityCollector implements DiscoveryAdapter {
  source = SOURCE;
  market = 'domestic' as const;
  tier = 1 as const;
  reliability = 0.84;

  async collect(options: DiscoveryCollectOptions = {}): Promise<DiscoveryResult> {
    const fetchedAt = new Date().toISOString();
    const limit = Math.max(1, Math.min(Number(options.limit || 30), 80));
    if (options.dryRun) return mkResult(fetchedAt, mockSignals().slice(0, limit), 'ready');

    const cooldown = await cooldownSymbolSet();
    const rows = await query(`
      WITH latest AS (
        SELECT DISTINCT ON (stock_code, factor_name)
               stock_code, company_name, factor_name, factor_value, rank, decile, metadata, created_at
          FROM investment.korean_factor_log
         WHERE created_at >= NOW() - INTERVAL '7 days'
           AND stock_code ~ '^[0-9]{6}$'
         ORDER BY stock_code, factor_name, created_at DESC
      ),
      aggregated AS (
        SELECT stock_code,
               MAX(company_name) AS company_name,
               MAX(NULLIF(metadata->>'composite', '')::double precision) AS composite,
               MIN(rank)::int AS best_rank,
               MIN(decile)::int AS best_decile,
               JSONB_OBJECT_AGG(factor_name, factor_value) AS factors,
               MAX(created_at) AS latest_at
          FROM latest
         GROUP BY stock_code
      )
      SELECT *
        FROM aggregated
       WHERE composite IS NOT NULL
       ORDER BY composite DESC, best_rank ASC NULLS LAST
       LIMIT $1
    `, [limit * 3]).catch(() => []);

    const signals = (rows || [])
      .filter((row) => !cooldown.has(String(row.stock_code || '').trim()))
      .map((row): DiscoverySignal | null => {
        const symbol = String(row.stock_code || '').trim();
        if (!/^\d{6}$/.test(symbol)) return null;
        const composite = clamp01(row.composite, 0.5);
        const decileBoost = row.best_decile ? Math.max(0, (11 - Number(row.best_decile)) / 100) : 0;
        const score = clamp01(0.52 + composite * 0.36 + decileBoost, 0.6);
        return {
          symbol,
          score: round(score, 3),
          confidence: round(Math.max(0.55, Math.min(0.86, 0.58 + composite * 0.24)), 3),
          reason: `OpenDART/Factor 국내 우량 후보: ${row.company_name || symbol}`,
          reasonCode: 'korea_public_data_quality',
          qualityFlags: ['korea_public_data_factor', 'opendart_shadow', 'cooldown_prefiltered'],
          raw: {
            companyName: row.company_name || null,
            composite: round(composite, 4),
            bestRank: row.best_rank ?? null,
            bestDecile: row.best_decile ?? null,
            factors: row.factors || {},
            latestAt: row.latest_at || null,
          },
        };
      })
      .filter(Boolean)
      .slice(0, limit);

    return mkResult(fetchedAt, signals, signals.length ? 'ready' : 'insufficient');
  }
}

export default KoreaPublicDataQualityCollector;
