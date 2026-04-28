// @ts-nocheck
// Discovery Orchestrator — 모든 어댑터 병렬 수집 + candidate_universe DB 저장
// Kill switch: LUNA_DISCOVERY_ORCHESTRATOR_ENABLED=false → 즉시 반환
//
// 사용법:
//   import { runDiscoveryOrchestrator } from './discovery-orchestrator.ts';
//   const result = await runDiscoveryOrchestrator({ dryRun: true });

import type {
  DiscoveryAdapter,
  DiscoveryMarket,
  DiscoveryOrchestratorResult,
  DiscoverySignal,
  DiscoveryCollectOptions,
} from './types.ts';

import { TossPopular100Collector } from './domestic/toss-popular-100.ts';
import { DartDisclosureCollector } from './domestic/dart-disclosure-collector.ts';
import { CoinGeckoTrendingCollector } from './crypto/coingecko-trending.ts';
import {
  upsertCandidateSignals,
  ensureCandidateUniverseTable,
  purgeExpiredCandidates,
} from './discovery-store.ts';

// ─── 어댑터 레지스트리 ────────────────────────────────────────────────

function buildAdapters(): DiscoveryAdapter[] {
  return [
    // 국내장 tier1
    new TossPopular100Collector(),
    new DartDisclosureCollector(),
    // 암호화폐 tier1
    new CoinGeckoTrendingCollector(),
    // 추후 추가: overseas/yahoo-finance-trending, overseas/sec-edgar-collector 등
  ];
}

// ─── 메인 오케스트레이터 ──────────────────────────────────────────────

export interface OrchestratorOptions extends DiscoveryCollectOptions {
  markets?: DiscoveryMarket[];      // 기본: 모든 시장
  ttlHours?: number;               // DB TTL (기본: 24)
  skipDbWrite?: boolean;            // 테스트용
}

export async function runDiscoveryOrchestrator(
  options: OrchestratorOptions = {},
): Promise<DiscoveryOrchestratorResult> {
  const enabled = process.env.LUNA_DISCOVERY_ORCHESTRATOR_ENABLED === 'true';

  if (!enabled && !options.dryRun) {
    console.log('[discovery-orchestrator] kill switch OFF → 스킵');
    return buildEmptyResult();
  }

  const {
    markets,
    ttlHours = 24,
    skipDbWrite = false,
    dryRun = false,
    limit = 100,
    timeoutMs = 8000,
  } = options;

  const orchestratedAt = new Date().toISOString();
  console.log(`[discovery-orchestrator] 수집 시작 (dryRun=${dryRun})`);

  // DB 초기화 (테이블 없으면 생성)
  if (!skipDbWrite && !dryRun) {
    await ensureCandidateUniverseTable().catch((e) => {
      console.log(`[discovery-orchestrator] DB 초기화 경고: ${e?.message}`);
    });
    // 만료 후보 정리
    const purged = await purgeExpiredCandidates().catch(() => 0);
    if (purged > 0) console.log(`[discovery-orchestrator] 만료 후보 ${purged}개 정리`);
  }

  const adapters = buildAdapters().filter((a) => !markets || markets.includes(a.market));

  // 모든 어댑터 병렬 실행 (1개 실패 시 다른 어댑터 영향 없음)
  const settled = await Promise.allSettled(
    adapters.map((adapter) =>
      adapter.collect({ limit, timeoutMs, dryRun }).then((result) => ({ adapter, result })),
    ),
  );

  const errors: Array<{ adapter: string; error: string }> = [];
  const byMarket: Record<DiscoveryMarket, DiscoverySignal[]> = {
    domestic: [], overseas: [], crypto: [],
  };

  for (const outcome of settled) {
    if (outcome.status === 'rejected') {
      errors.push({ adapter: 'unknown', error: String(outcome.reason) });
      continue;
    }
    const { adapter, result } = outcome.value;
    if (!result || result.quality.status === 'insufficient') {
      console.log(`[discovery-orchestrator] ${adapter.source} insufficient → 스킵`);
      continue;
    }

    console.log(`[discovery-orchestrator] ${adapter.source} ${result.signals.length}개 (${result.quality.status})`);

    // 시장별 신호 병합
    const market = adapter.market;
    for (const sig of result.signals) {
      byMarket[market].push(sig);
    }

    // DB 저장
    if (!skipDbWrite && !dryRun && result.signals.length > 0) {
      await upsertCandidateSignals(
        result.signals,
        market,
        adapter.source,
        adapter.tier,
        ttlHours,
      ).catch((e) => {
        console.log(`[discovery-orchestrator] DB 저장 오류 (${adapter.source}): ${e?.message}`);
        errors.push({ adapter: adapter.source, error: e?.message });
      });
    }
  }

  // 중복 제거 + 점수 정렬
  const merged = {
    domestic: dedupeByMaxScore(byMarket.domestic),
    overseas: dedupeByMaxScore(byMarket.overseas),
    crypto:   dedupeByMaxScore(byMarket.crypto),
  };

  const successCount = settled.filter((s) => s.status === 'fulfilled' && s.value.result.quality.status !== 'insufficient').length;
  const totalSignals = Object.values(merged).reduce((s, arr) => s + arr.length, 0);

  console.log(`[discovery-orchestrator] 완료 — 성공 ${successCount}/${adapters.length}, 총 ${totalSignals}개 신호`);

  return {
    orchestratedAt,
    markets: {
      domestic: [],
      overseas: [],
      crypto: [],
    },
    merged,
    errors,
    stats: {
      totalAdapters: adapters.length,
      successCount,
      errorCount: errors.length,
      totalSignals,
    },
  };
}

function dedupeByMaxScore(signals: DiscoverySignal[]): DiscoverySignal[] {
  const seen = new Map<string, DiscoverySignal>();
  for (const s of signals) {
    const prev = seen.get(s.symbol);
    if (!prev || s.score > prev.score) seen.set(s.symbol, s);
  }
  return Array.from(seen.values()).sort((a, b) => b.score - a.score);
}

function buildEmptyResult(): DiscoveryOrchestratorResult {
  return {
    orchestratedAt: new Date().toISOString(),
    markets: { domestic: [], overseas: [], crypto: [] },
    merged: { domestic: [], overseas: [], crypto: [] },
    errors: [],
    stats: { totalAdapters: 0, successCount: 0, errorCount: 0, totalSignals: 0 },
  };
}

export default runDiscoveryOrchestrator;
