// @ts-nocheck
// 토스 인기 종목 어댑터 — 기존 scout-scraper 재사용
// domestic tier1, 신뢰도 0.85
// 이미 scout-scraper에서 Playwright headless로 수집 중 → 구조 통합

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import type { DiscoveryAdapter, DiscoveryResult, DiscoveryCollectOptions, DiscoverySignal } from '../types.ts';

const SOURCE = 'toss_popular';

export class TossPopular100Collector implements DiscoveryAdapter {
  source = SOURCE;
  market = 'domestic' as const;
  tier = 1 as const;
  reliability = 0.85;

  async collect(options: DiscoveryCollectOptions = {}): Promise<DiscoveryResult> {
    const { limit = 50, timeoutMs = 30_000, dryRun = false } = options;
    const fetchedAt = new Date().toISOString();

    if (dryRun) {
      return mkResult(fetchedAt, buildMockSignals(), 'ready');
    }

    try {
      // scout-scraper 동적 import (Playwright 의존성)
      const { collectScoutData } = await import('../../scout-scraper.ts').catch(() => null) || {};
      if (!collectScoutData) {
        console.log('[toss-collector] scout-scraper import 실패 → mock 반환');
        return mkResult(fetchedAt, buildMockSignals(), 'degraded');
      }

      const raw = await collectScoutData({ dryRun: false });
      const signals = extractSignalsFromScout(raw, limit);

      const status = signals.length >= 5 ? 'ready' : signals.length > 0 ? 'degraded' : 'insufficient';
      console.log(`[toss-collector] ${signals.length}개 신호 추출`);
      return mkResult(fetchedAt, signals, status);
    } catch (err) {
      console.log(`[toss-collector] 수집 실패: ${err?.message}`);
      return mkResult(fetchedAt, [], 'insufficient');
    }
  }
}

function extractSignalsFromScout(raw: unknown, limit: number): DiscoverySignal[] {
  if (!raw || typeof raw !== 'object') return [];

  const signals: DiscoverySignal[] = [];
  const seen = new Set<string>();

  const rawAny = raw as Record<string, unknown>;

  // sections.top10 → 최고 점수 (0.82)
  const top10: unknown[] = (rawAny.sections as any)?.top10 || [];
  for (const item of top10) {
    const symbol = extractSymbol(item);
    if (symbol && !seen.has(symbol)) {
      seen.add(symbol);
      signals.push({ symbol, score: 0.82, reason: '토스 TOP10', raw: { item } });
    }
  }

  // sections.aiSignals → 높은 점수 (0.84)
  const aiSignals: unknown[] = (rawAny.sections as any)?.aiSignals || [];
  for (const item of aiSignals) {
    const symbol = extractSymbol(item);
    if (symbol && !seen.has(symbol)) {
      seen.add(symbol);
      signals.push({ symbol, score: 0.84, reason: '토스 AI 신호', raw: { item } });
    } else if (symbol) {
      // 이미 있으면 점수 상향
      const existing = signals.find((s) => s.symbol === symbol);
      if (existing) existing.score = Math.min(1, existing.score + 0.05);
    }
  }

  // signals 배열 (toss-market-intel 표준 출력)
  const rawSignals: unknown[] = (rawAny.signals as unknown[]) || [];
  for (const sig of rawSignals) {
    const s = sig as Record<string, unknown>;
    const symbol = String(s.symbol || '').trim();
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    signals.push({
      symbol,
      score: Number(s.score || 0.70),
      reason: `토스: ${s.label || s.source || ''}`,
      raw: { sig },
    });
  }

  return signals.slice(0, limit);
}

function extractSymbol(item: unknown): string | null {
  if (!item) return null;
  if (typeof item === 'string') {
    const m = item.match(/\b(\d{6})\b/);
    return m ? m[1] : null;
  }
  if (typeof item === 'object') {
    const o = item as Record<string, unknown>;
    const sym = o.symbol || o.code || o.stock_code;
    if (sym && /^\d{6}$/.test(String(sym))) return String(sym);
  }
  return null;
}

function buildMockSignals(): DiscoverySignal[] {
  return [
    { symbol: '005930', score: 0.84, reason: '토스 mock: 삼성전자 AI신호', raw: {} },
    { symbol: '000660', score: 0.82, reason: '토스 mock: SK하이닉스 TOP10', raw: {} },
    { symbol: '035420', score: 0.75, reason: '토스 mock: 네이버 스캔', raw: {} },
    { symbol: '035720', score: 0.72, reason: '토스 mock: 카카오 스캔', raw: {} },
    { symbol: '005380', score: 0.70, reason: '토스 mock: 현대차 스캔', raw: {} },
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
    quality: { status, sourceTier: 1, signalCount: signals.length },
  };
}

export default TossPopular100Collector;
