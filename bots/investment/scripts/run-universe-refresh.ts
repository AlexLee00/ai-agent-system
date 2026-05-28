#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/run-universe-refresh.ts — KIS + Binance 유니버스 일일 갱신 + 동적 유니버스 선택
 *
 * 매일 08:30 KST (장 시작 전)
 * launchd: ai.luna.universe-refresh-daily-0830.plist
 *
 * 실행 내용:
 *   1. KIS 국내 거래량 Top 50 갱신 (KRX Data.go.kr)
 *   2. KIS 해외 거래량 Top 50 갱신 (큐레이션 목록)
 *   3. Binance Top 30 갱신 (spot USDT quoteVolume)
 *   4. 결과 캐시 파일 저장
 *   5. 동적 유니버스 선택 (3축 × 체제, universe_selection_shadow 기록)
 *   6. 결과 요약 + 텔레그램 보고
 */

import { initHubConfig } from '../../../packages/core/lib/llm-keys.ts';
import { refreshKisTopVolumeUniverses } from '../shared/kis-top-volume-universe.ts';
import { fetchBinanceTopVolumeUniverse } from '../shared/binance-top-volume-universe.ts';
import { buildDynamicUniverse, getCurrentRegime } from '../shared/dynamic-universe-selector.ts';

async function sendTelegram(message) {
  try {
    const hubUrl = process.env.HUB_URL || 'http://localhost:7788';
    const hubToken = process.env.HUB_AUTH_TOKEN;
    if (!hubToken) return;
    await fetch(`${hubUrl}/hub/notifications/telegram`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hubToken}`,
      },
      body: JSON.stringify({ message, source: 'universe-refresh', parseMode: 'Markdown' }),
    }).catch(() => null);
  } catch {
    // ignore
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`[UniverseRefresh] ${new Date().toISOString()} 유니버스 갱신 시작`);

  try {
    await initHubConfig().catch(() => null);
  } catch {}

  const results = await Promise.allSettled([
    refreshKisTopVolumeUniverses(),
    fetchBinanceTopVolumeUniverse().catch((err) => ({ error: err?.message })),
  ]);

  const [kisResult, binanceResult] = results;

  const kis = kisResult.status === 'fulfilled' ? kisResult.value : { error: String(kisResult.reason) };
  const binance = binanceResult.status === 'fulfilled' ? binanceResult.value : { error: String(binanceResult.reason) };

  const domesticCount = kis.domestic?.symbols?.length ?? 0;
  const overseasCount = kis.overseas?.symbols?.length ?? 0;
  const cryptoCount = Array.isArray(binance.symbols) ? binance.symbols.length : 0;

  console.log(`[UniverseRefresh] 국내 ${domesticCount}종목 | 해외 ${overseasCount}종목 | 크립토 ${cryptoCount}종목`);

  if (kis.domesticError) console.warn(`[UniverseRefresh] 국내 오류: ${kis.domesticError}`);
  if (kis.overseasError) console.warn(`[UniverseRefresh] 해외 오류: ${kis.overseasError}`);
  if (binance.error) console.warn(`[UniverseRefresh] 크립토 오류: ${binance.error}`);

  // 동적 유니버스 선택 (raw 데이터 갱신 후 실행)
  const dynamicResults = await Promise.allSettled([
    (async () => {
      const regime = await getCurrentRegime('binance').catch(() => 'RANGING');
      return buildDynamicUniverse(regime, 'binance', { dryRun });
    })(),
    (async () => {
      const regime = await getCurrentRegime('kis').catch(() => 'RANGING');
      return buildDynamicUniverse(regime, 'kis', { dryRun });
    })(),
    (async () => {
      const regime = await getCurrentRegime('kis_overseas').catch(() => 'RANGING');
      return buildDynamicUniverse(regime, 'kis_overseas', { dryRun });
    })(),
  ]);

  const [dynCrypto, dynDomestic, dynOverseas] = dynamicResults.map((r) =>
    r.status === 'fulfilled' ? r.value : null,
  );

  if (!dryRun) {
    const today = new Date().toISOString().split('T')[0];
    const cryptoTop5 = (dynCrypto?.selectedSymbols?.slice(0, 5) || []).map((s) => s.symbol).join(', ') || (binance.symbols || []).slice(0, 5).join(', ') || '없음';
    const domTop5 = (dynDomestic?.selectedSymbols?.slice(0, 5) || []).map((s) => s.symbol).join(', ') || kis.domestic?.symbols?.slice(0, 5).join(', ') || '없음';
    const ovTop5 = (dynOverseas?.selectedSymbols?.slice(0, 5) || []).map((s) => s.symbol).join(', ') || kis.overseas?.symbols?.slice(0, 5).join(', ') || '없음';
    const msg = `📊 *루나 유니버스 갱신 — ${today}*\n\n` +
      `🇰🇷 국내 Top ${dynDomestic?.universeSize ?? domesticCount}: ${domTop5}...\n` +
      `🌍 해외 Top ${dynOverseas?.universeSize ?? overseasCount}: ${ovTop5}...\n` +
      `₿  크립토 Top ${dynCrypto?.universeSize ?? cryptoCount}: ${cryptoTop5}...\n` +
      `\n📐 *동적 선택 (3축 × 체제)*\n` +
      `  • 크립토 체제: ${dynCrypto?.regime ?? '-'}\n` +
      `  • 국내 체제: ${dynDomestic?.regime ?? '-'}\n\n` +
      `_갱신 시각: ${new Date().toISOString()}_`;
    await sendTelegram(msg);
  }

  console.log(`[UniverseRefresh] 완료 (dynamic: crypto=${dynCrypto?.universeSize ?? 0} domestic=${dynDomestic?.universeSize ?? 0} overseas=${dynOverseas?.universeSize ?? 0})`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`[UniverseRefresh] 오류:`, err);
  process.exit(1);
});
