// @ts-nocheck
import * as db from './db.ts';

export function capDynamicUniverse(symbols, maxDynamic, source = 'dynamic') {
  if (!Array.isArray(symbols) || symbols.length === 0) return [];
  const limit = Number(maxDynamic || 0);
  if (!Number.isFinite(limit) || limit <= 0 || symbols.length <= limit) return symbols;
  const capped = symbols.slice(0, limit);
  console.log(`  ✂️ [유니버스 캡] ${source} ${symbols.length}개 -> ${capped.length}개 (max_dynamic=${limit})`);
  return capped;
}

/**
 * 동적 유니버스 스크리닝 결과를 공통 폴백 체계로 해석
 * 순서:
 *  1. 실시간 스크리닝
 *  2. prescreened/watchlist 캐시
 *  3. screening_history
 *  4. 설정 기본 종목
 */
export async function resolveSymbolsWithFallback({
  market,
  screen,
  loadCache = null,
  defaultSymbols = [],
  screenLabel = '스크리닝',
  cacheLabel = 'RAG 폴백',
}) {
  try {
    const screening = await screen();
    const symbols = screening?.all || [];
    if (!symbols.length) throw new Error('empty_screening_result');
    await db.initSchema();
    await db.insertScreeningHistory({
      market,
      core: screening?.core || [],
      dynamic: screening?.dynamic || symbols,
      screeningData: screening,
    });
    console.log(`🔍 [${screenLabel}] ${symbols.join(', ')}`);
    return { symbols, source: 'screening', screening, shouldCountFailure: false };
  } catch (e) {
    const isEmptyResult = e?.message === 'empty_screening_result';
    console.warn(`⚠️ ${screenLabel} 실패 — 다단계 폴백 시도: ${e.message}`);

    const cached = loadCache?.();
    if (cached?.symbols?.length > 0) {
      const ageMin = Math.floor((Date.now() - (cached.savedAt || 0)) / 60000);
      console.log(`  📚 [${cacheLabel}] 최근 스크리닝 재사용 (${ageMin}분 전): ${cached.symbols.join(', ')}`);
      return { symbols: cached.symbols, source: 'cache', error: e, shouldCountFailure: !isEmptyResult };
    }

    try {
      await db.initSchema();
      const recent = await db.getRecentScreeningSymbols(market, 3);
      if (recent.length > 0) {
        console.log(`  🗃️ [히스토리 폴백] 최근 스크리닝 재사용: ${recent.join(', ')}`);
        return { symbols: recent, source: 'history', error: e, shouldCountFailure: !isEmptyResult };
      }
    } catch { /* 무시 */ }

    console.log(`  ⚙️ [설정 폴백] config 기본 종목 사용: ${defaultSymbols.join(', ')}`);
    return { symbols: defaultSymbols, source: 'default', error: e, shouldCountFailure: !isEmptyResult };
  }
}

/**
 * 현재 보유 live 포지션 심볼을 후보군에 병합
 */
export async function appendHeldSymbols(symbols, exchange) {
  try {
    await db.initSchema();
    const positions = await db.getAllPositions(exchange, false);
    const heldSymbols = positions
      .map(p => p.symbol)
      .filter(s => !symbols.includes(s));
    if (heldSymbols.length > 0) {
      console.log(`  📌 보유 포지션 추가: ${heldSymbols.join(', ')}`);
      return [...symbols, ...heldSymbols];
    }
  } catch { /* 무시 */ }
  return symbols;
}
