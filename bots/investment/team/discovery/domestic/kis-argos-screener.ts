// @ts-nocheck
// KIS/Argos 국내장 discovery fallback.
// Toss/DART가 비어도 KIS 공식 일봉으로 유동성 검증된 후보를 universe에 공급한다.

import type { DiscoveryAdapter, DiscoveryCollectOptions, DiscoveryResult, DiscoverySignal } from '../types.ts';
import { screenDomesticSymbols } from '../../argos.ts';

const SOURCE = 'kis_argos_screener';

export class KisArgosScreenerCollector implements DiscoveryAdapter {
  source = SOURCE;
  market = 'domestic' as const;
  tier = 2 as const;
  reliability = 0.72;

  async collect(options: DiscoveryCollectOptions = {}): Promise<DiscoveryResult> {
    const { limit = 20, dryRun = false } = options;
    const fetchedAt = new Date().toISOString();
    if (dryRun) {
      return mkResult(fetchedAt, buildMockSignals().slice(0, limit), 'ready');
    }

    try {
      const result = await screenDomesticSymbols(Math.max(1, Math.min(Number(limit) || 20, 20)));
      const signals = (result?.screening || [])
        .map((row): DiscoverySignal | null => {
          const symbol = String(row.symbol || '').trim();
          if (!/^\d{6}$/.test(symbol)) return null;
          const turnover = Number(row.dollarVolume || 0) || (Number(row.price || 0) * Number(row.volume || 0));
          const sourceBoost = Math.min(0.18, Number(row.sourceCount || 1) * 0.03);
          const liquidityBoost = turnover > 0 ? Math.min(0.12, Math.log10(turnover) / 100) : 0;
          const score = Math.max(0.1, Math.min(0.9, 0.58 + sourceBoost + liquidityBoost));
          return {
            symbol,
            score: Math.round(score * 1000) / 1000,
            confidence: Math.round((0.6 + sourceBoost) * 1000) / 1000,
            reason: 'KIS/Argos 국내 후보 보강',
            reasonCode: 'kis_argos_screening_fallback',
            qualityFlags: dryRun ? ['dry_run'] : [],
            raw: {
              price: row.price || 0,
              volume: row.volume || 0,
              turnover,
              quoteSource: row.quoteSource || null,
              sourceNames: row.sourceNames || [],
            },
          };
        })
        .filter(Boolean)
        .slice(0, limit);
      return mkResult(fetchedAt, signals, signals.length ? 'ready' : 'insufficient');
    } catch (error) {
      console.log(`[kis-argos-screener] 수집 실패: ${error?.message || error}`);
      return mkResult(fetchedAt, [], 'insufficient');
    }
  }
}

function buildMockSignals(): DiscoverySignal[] {
  return [
    {
      symbol: '005930',
      score: 0.74,
      confidence: 0.66,
      reason: 'KIS/Argos mock: 국내 대형주 fallback',
      reasonCode: 'kis_argos_screening_fallback',
      qualityFlags: ['dry_run'],
      raw: { quoteSource: 'mock' },
    },
    {
      symbol: '000660',
      score: 0.72,
      confidence: 0.64,
      reason: 'KIS/Argos mock: 국내 반도체 fallback',
      reasonCode: 'kis_argos_screening_fallback',
      qualityFlags: ['dry_run'],
      raw: { quoteSource: 'mock' },
    },
    {
      symbol: '035420',
      score: 0.68,
      confidence: 0.61,
      reason: 'KIS/Argos mock: 국내 인터넷 fallback',
      reasonCode: 'kis_argos_screening_fallback',
      qualityFlags: ['dry_run'],
      raw: { quoteSource: 'mock' },
    },
  ];
}

function mkResult(
  fetchedAt: string,
  signals: DiscoverySignal[],
  status: 'ready' | 'degraded' | 'insufficient',
): DiscoveryResult {
  return {
    source: SOURCE,
    market: 'domestic',
    fetchedAt,
    signals,
    quality: { status, sourceTier: 2, signalCount: signals.length },
  };
}

export default KisArgosScreenerCollector;
