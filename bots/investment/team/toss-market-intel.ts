// @ts-nocheck
/**
 * team/toss-market-intel.ts — 토스 웹 시장 인텔 표준화 레이어
 *
 * 역할:
 *   - scout-scraper의 원시 payload를 screening collect 친화적으로 구조화
 *   - 추후 MCP 서버가 붙어도 같은 출력 계약을 유지
 */

import { collectScoutData } from './scout-scraper.ts';

function normalizeSignal(item = {}) {
  return {
    symbol: String(item?.symbol || '').trim().toUpperCase(),
    market: String(item?.market || '').trim() || 'unknown',
    source: String(item?.source || '').trim() || 'scan',
    label: String(item?.label || '').trim() || '',
    score: Number(item?.score || 0),
    evidence: String(item?.evidence || '').trim() || '',
  };
}

function summarizeSections(sections = {}) {
  return Object.fromEntries(
    Object.entries(sections || {}).map(([key, values]) => [key, Array.isArray(values) ? values.length : 0]),
  );
}

export async function collectTossMarketIntel({
  dryRun = false,
  limit = 10,
  headless = process.env.PLAYWRIGHT_HEADLESS !== 'false',
} = {}) {
  const payload = await collectScoutData({ dryRun, limit, headless });
  const signals = (Array.isArray(payload?.signals) ? payload.signals : [])
    .map(normalizeSignal)
    .filter((item) => item.symbol);
  const sectionCounts = summarizeSections(payload?.sections || {});
  const status = signals.length > 0 ? 'ready' : Object.values(sectionCounts).some((count) => Number(count || 0) > 0) ? 'degraded' : 'insufficient';

  return {
    source: 'toss_web',
    transport: String(payload?.source || 'unknown'),
    fetchedAt: payload?.fetchedAt || new Date().toISOString(),
    targetUrl: payload?.targetUrl || null,
    urls: payload?.urls || {},
    sections: payload?.sections || {},
    sectionCounts,
    signals,
    quality: {
      status,
      signalCount: signals.length,
      sectionCount: Object.values(sectionCounts).reduce((sum, count) => sum + Number(count || 0), 0),
      sourceTier: 'tier2',
    },
  };
}

export default {
  collectTossMarketIntel,
};
