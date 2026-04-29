// @ts-nocheck
// Phase A Discovery Orchestrator 스모크 테스트
// 실행: npx tsx bots/investment/scripts/runtime-discovery-orchestrator-smoke.ts
//
// 검증:
//   1. 각 어댑터 mock/dryRun 수집 정상 동작
//   2. 신호 구조 (symbol, score 0~1, reason) 검증
//   3. 시장별 중복 제거 검증
//   4. Kill switch (LUNA_DISCOVERY_ORCHESTRATOR_ENABLED=false) 검증
//   5. graceful degradation (adapter 1개 실패 시 전체 미실패) 검증

import { runDiscoveryOrchestrator } from '../team/discovery/discovery-orchestrator.ts';
import { TossPopular100Collector } from '../team/discovery/domestic/toss-popular-100.ts';
import { DartDisclosureCollector } from '../team/discovery/domestic/dart-disclosure-collector.ts';
import { CoinGeckoTrendingCollector } from '../team/discovery/crypto/coingecko-trending.ts';

const PASS = '✅';
const FAIL = '❌';
const WARN = '⚠️';

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string, detail?: string) {
  if (cond) {
    console.log(`${PASS} ${msg}`);
    passed++;
  } else {
    console.log(`${FAIL} ${msg}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

function assertWarn(cond: boolean, msg: string) {
  if (cond) {
    console.log(`${PASS} ${msg}`);
    passed++;
  } else {
    console.log(`${WARN} ${msg} (경고만, 실패 아님)`);
  }
}

// ─── 테스트 1: TossPopular100Collector dryRun ────────────────────────

console.log('\n── 테스트 1: TossPopular100Collector dryRun ──');
{
  const adapter = new TossPopular100Collector();
  assert(adapter.source === 'toss_popular', '소스명 확인');
  assert(adapter.market === 'domestic', '시장 확인');
  assert(adapter.tier === 1, '티어 확인');
  assert(adapter.reliability === 0.85, '신뢰도 확인');

  const result = await adapter.collect({ dryRun: true });
  assert(result.source === 'toss_popular', '결과 소스명');
  assert(result.market === 'domestic', '결과 시장');
  assert(result.quality.status === 'ready', 'mock 품질 ready');
  assert(result.signals.length > 0, '신호 최소 1개');
  for (const sig of result.signals) {
    assert(typeof sig.symbol === 'string' && sig.symbol.length > 0, `symbol 유효 (${sig.symbol})`);
    assert(sig.score >= 0 && sig.score <= 1, `score 범위 (${sig.symbol}: ${sig.score})`);
    assert(typeof sig.reason === 'string', `reason 문자열 (${sig.symbol})`);
  }
}

// ─── 테스트 2: DartDisclosureCollector dryRun ────────────────────────

console.log('\n── 테스트 2: DartDisclosureCollector dryRun ──');
{
  const adapter = new DartDisclosureCollector();
  assert(adapter.source === 'dart_disclosure', '소스명 확인');
  assert(adapter.market === 'domestic', '시장 확인');
  assert(adapter.tier === 1, '티어 확인');
  assert(adapter.reliability === 1.0, '신뢰도 확인 (1.0)');

  const result = await adapter.collect({ dryRun: true });
  assert(result.source === 'dart_disclosure', '결과 소스명');
  assert(result.signals.length > 0, 'mock 신호 최소 1개');
  for (const sig of result.signals) {
    assert(/^\d{6}$/.test(sig.symbol), `국내장 6자리 코드 (${sig.symbol})`);
    assert(sig.score >= 0.60, `DART score >= 0.60 (${sig.symbol}: ${sig.score})`);
  }
}

// ─── 테스트 3: DartDisclosureCollector kill switch ───────────────────

console.log('\n── 테스트 3: DART kill switch (LUNA_DISCOVERY_DART=false) ──');
{
  const origEnv = process.env.LUNA_DISCOVERY_DART;
  process.env.LUNA_DISCOVERY_DART = 'false';

  const adapter = new DartDisclosureCollector();
  const result = await adapter.collect({ dryRun: false });
  assert(result.quality.status === 'insufficient', 'kill switch → insufficient');
  assert(result.signals.length === 0, 'kill switch → 신호 없음');

  process.env.LUNA_DISCOVERY_DART = origEnv;
}

// ─── 테스트 4: CoinGeckoTrendingCollector dryRun ─────────────────────

console.log('\n── 테스트 4: CoinGeckoTrendingCollector dryRun ──');
{
  const adapter = new CoinGeckoTrendingCollector();
  assert(adapter.source === 'coingecko_trending', '소스명 확인');
  assert(adapter.market === 'crypto', '시장 확인');
  assert(adapter.tier === 1, '티어 확인');

  const result = await adapter.collect({ dryRun: true });
  assert(result.market === 'crypto', '결과 시장');
  assert(result.signals.length > 0, 'mock 신호 최소 1개');
  for (const sig of result.signals) {
    assert(sig.symbol.endsWith('USDT'), `Binance USDT 페어 (${sig.symbol})`);
    assert(sig.score >= 0 && sig.score <= 1, `score 범위 (${sig.symbol}: ${sig.score})`);
  }
}

// ─── 테스트 5: Orchestrator dryRun 전체 실행 ─────────────────────────

console.log('\n── 테스트 5: Orchestrator dryRun 전체 실행 ──');
{
  const orig = process.env.LUNA_DISCOVERY_ORCHESTRATOR_ENABLED;
  process.env.LUNA_DISCOVERY_ORCHESTRATOR_ENABLED = 'true';

  const result = await runDiscoveryOrchestrator({ dryRun: true, skipDbWrite: true });
  assert(typeof result.orchestratedAt === 'string', 'orchestratedAt 타임스탬프');
  assert(result.stats.totalAdapters >= 3, `어댑터 3개 이상 (${result.stats.totalAdapters}개)`);
  assert(result.stats.successCount >= 1, `성공 어댑터 최소 1개 (${result.stats.successCount}개)`);
  assert(result.stats.totalSignals > 0, `총 신호 최소 1개 (${result.stats.totalSignals}개)`);

  // 시장별 신호 확인
  assert(result.merged.domestic.length > 0, `국내장 신호 (${result.merged.domestic.length}개)`);
  assert(result.merged.crypto.length > 0, `암호화폐 신호 (${result.merged.crypto.length}개)`);

  // 중복 제거 확인
  const domesticSymbols = result.merged.domestic.map((s) => s.symbol);
  const uniqueDomestic = new Set(domesticSymbols);
  assert(domesticSymbols.length === uniqueDomestic.size, '국내장 symbol 중복 없음');

  const cryptoSymbols = result.merged.crypto.map((s) => s.symbol);
  const uniqueCrypto = new Set(cryptoSymbols);
  assert(cryptoSymbols.length === uniqueCrypto.size, '암호화폐 symbol 중복 없음');

  process.env.LUNA_DISCOVERY_ORCHESTRATOR_ENABLED = orig;
}

// ─── 테스트 6: Orchestrator kill switch ──────────────────────────────

console.log('\n── 테스트 6: Orchestrator kill switch (ENABLED=false) ──');
{
  const orig = process.env.LUNA_DISCOVERY_ORCHESTRATOR_ENABLED;
  process.env.LUNA_DISCOVERY_ORCHESTRATOR_ENABLED = 'false';

  const result = await runDiscoveryOrchestrator({ skipDbWrite: true });
  assert(result.stats.totalAdapters === 0, 'kill switch → 어댑터 미실행');
  assert(result.stats.totalSignals === 0, 'kill switch → 신호 없음');

  process.env.LUNA_DISCOVERY_ORCHESTRATOR_ENABLED = orig;
}

// ─── 테스트 7: Graceful degradation — 어댑터 실패 시 전체 미실패 ─────

console.log('\n── 테스트 7: Graceful degradation (adapter throw 시뮬레이션) ──');
{
  const orig = process.env.LUNA_DISCOVERY_ORCHESTRATOR_ENABLED;
  process.env.LUNA_DISCOVERY_ORCHESTRATOR_ENABLED = 'true';
  const okAdapter = {
    source: 'smoke_ok_adapter',
    market: 'crypto',
    tier: 1,
    reliability: 0.9,
    collect: async () => ({
      source: 'smoke_ok_adapter',
      market: 'crypto',
      fetchedAt: new Date().toISOString(),
      signals: [{ symbol: 'SMOKE/USDT', score: 0.7, reason: 'smoke graceful success' }],
      quality: { status: 'ready', sourceTier: 1, signalCount: 1 },
    }),
  };
  const throwingAdapter = {
    source: 'smoke_throw_adapter',
    market: 'crypto',
    tier: 1,
    reliability: 0.1,
    collect: async () => {
      throw new Error('smoke_adapter_failure');
    },
  };

  const result = await runDiscoveryOrchestrator({
    dryRun: true,
    skipDbWrite: true,
    adapters: [okAdapter, throwingAdapter],
  });
  assert(
    result.stats.successCount + result.stats.errorCount === result.stats.totalAdapters,
    '성공 + 오류 = 총 어댑터 (graceful degradation 구조 확인)',
  );
  assert(result.stats.successCount === 1, '성공 어댑터 1개 유지');
  assert(result.stats.errorCount === 1, '실패 어댑터 1개 기록');
  assert(result.errors?.[0]?.adapter === 'smoke_throw_adapter', '실패 어댑터 source 보존');
  assert(result.merged.crypto.length === 1, '성공 신호는 유지');

  if (orig == null) delete process.env.LUNA_DISCOVERY_ORCHESTRATOR_ENABLED;
  else process.env.LUNA_DISCOVERY_ORCHESTRATOR_ENABLED = orig;
}

// ─── 결과 요약 ───────────────────────────────────────────────────────

console.log(`\n════════════════════════════════════`);
console.log(`Discovery Orchestrator Smoke 결과`);
console.log(`${PASS} 통과: ${passed}  ${FAIL} 실패: ${failed}`);
console.log(`════════════════════════════════════`);

if (failed > 0) {
  process.exit(1);
}
