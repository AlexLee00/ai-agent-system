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
export async function appendHeldSymbols(symbols, exchange, heldSymbolsOverride = null) {
  try {
    await db.initSchema();
    const heldSymbolsSource = Array.isArray(heldSymbolsOverride)
      ? heldSymbolsOverride
      : (await db.getAllPositions(exchange, false)).map((p) => p.symbol);
    const heldSymbols = heldSymbolsSource.filter((s) => !symbols.includes(s));
    if (heldSymbols.length > 0) {
      console.log(`  📌 보유 포지션 추가: ${heldSymbols.join(', ')}`);
      return [...symbols, ...heldSymbols];
    }
  } catch { /* 무시 */ }
  return symbols;
}

export async function resolveManagedPositionUniverse(exchange, {
  tradeMode = null,
  cryptoDustThresholdUsdt = 10,
} = {}) {
  await db.initSchema();

  const [positions, profiles] = await Promise.all([
    db.getAllPositions(exchange, false, tradeMode).catch(() => []),
    db.getActivePositionStrategyProfiles({ exchange, status: 'active', limit: 1000 }).catch(() => []),
  ]);

  const profileBySymbol = new Map();
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    const symbol = String(profile?.symbol || '').trim();
    if (!symbol || profileBySymbol.has(symbol)) continue;
    profileBySymbol.set(symbol, profile);
  }

  const lifecycleWeights = {
    exit_candidate: 300,
    exit_preview_requested: 290,
    adjust_candidate: 220,
    adjust_preview: 210,
    holding: 120,
    position_open: 100,
  };

  const entries = [];
  const dustSymbols = [];

  for (const position of Array.isArray(positions) ? positions : []) {
    const symbol = String(position?.symbol || '').trim();
    if (!symbol) continue;

    const profile = profileBySymbol.get(symbol) || null;
    const strategyState = profile?.strategy_state && typeof profile.strategy_state === 'object'
      ? profile.strategy_state
      : {};
    const lifecycleStatus = String(strategyState?.lifecycleStatus || 'holding').trim() || 'holding';
    const watchMission = String(profile?.strategy_context?.responsibilityPlan?.watchMission || '').trim() || null;
    const notionalValue = Number(position?.amount || 0) * Number(position?.avg_price || 0);
    const isCrypto = String(exchange || '').trim().toLowerCase() === 'binance';
    const isDust = isCrypto && notionalValue > 0 && notionalValue < Number(cryptoDustThresholdUsdt || 10);
    const managed = Boolean(profile?.id) || !isDust;

    const entry = {
      symbol,
      exchange: String(position?.exchange || exchange || '').trim(),
      tradeMode: String(position?.trade_mode || tradeMode || 'normal').trim(),
      lifecycleStatus,
      watchMission,
      notionalValue,
      isDust,
      managed,
      hasActiveProfile: Boolean(profile?.id),
      priority: Number(lifecycleWeights[lifecycleStatus] || 80) + (watchMission === 'risk_sentinel' ? 20 : 0),
    };

    if (!managed) {
      dustSymbols.push(symbol);
      continue;
    }

    entries.push(entry);
  }

  entries.sort((a, b) => b.priority - a.priority || a.symbol.localeCompare(b.symbol));

  const lifecycleCounts = entries.reduce((acc, item) => {
    acc[item.lifecycleStatus] = (acc[item.lifecycleStatus] || 0) + 1;
    return acc;
  }, {});

  return {
    symbols: entries.map((item) => item.symbol),
    entries,
    dustSymbols,
    lifecycleCounts,
    profiledCount: entries.filter((item) => item.hasActiveProfile).length,
    managedCount: entries.length,
  };
}
