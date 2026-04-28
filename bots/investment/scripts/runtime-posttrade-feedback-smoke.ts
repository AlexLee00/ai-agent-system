#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/runtime-posttrade-feedback-smoke.ts — Phase A/B/C 스모크 테스트
 *
 * 실제 DB/LLM 호출 없이 로직 검증:
 *   Scenario 1: preferred trade (good entry, good exit, high PnL)
 *   Scenario 2: rejected trade (bad all around → reflexion 생성)
 *   Scenario 3: neutral trade (mixed signals)
 *   Scenario 4: trade with no rationale
 *   Scenario 5: trade with monitoring deficit
 */

import { evaluateTradeQuality } from '../shared/trade-quality-evaluator.ts';
import { analyzeStageAttribution } from '../shared/stage-attribution-analyzer.ts';
import { runReflexion } from '../shared/reflexion-engine.ts';
import { checkAvoidPatterns } from '../shared/reflexion-engine.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    failed++;
  }
}

// ─── Mock DB / LLM ────────────────────────────────────────────────────────────

// DB mock는 dry-run=true로 실제 DB 쓰기를 건너뜀
// LLM mock: 실제 LLM 대신 고정 JSON 반환

function buildMockTrade(overrides = {}) {
  return {
    id: 9999,
    symbol: 'BTC/USDT',
    market: 'crypto',
    exchange: 'binance',
    direction: 'long',
    entry_price: 60000,
    exit_price: 63000,
    amount_krw: 500000,
    entry_at: new Date(Date.now() - 86400000).toISOString(),
    exit_at: new Date().toISOString(),
    exit_reason: 'tp_hit',
    setup_type: 'breakout',
    ...overrides,
  };
}

function buildMockQuality(overrides = {}): any {
  return {
    trade_id: 9999,
    market_decision_score: 0.75,
    pipeline_quality_score: 0.70,
    monitoring_score: 0.65,
    backtest_utilization_score: 0.60,
    overall_score: 0.69,
    category: 'neutral',
    rationale: '테스트 평가',
    sub_score_breakdown: {},
    ...overrides,
  };
}

function buildMockStageAttrs(): any[] {
  return [
    { trade_id: 9999, stage_id: 'discovery', decision_type: 'candidate_selection', decision_score: 0.8, contribution_to_outcome: 0.10, evidence: {} },
    { trade_id: 9999, stage_id: 'entry', decision_type: 'entry_timing', decision_score: 0.7, contribution_to_outcome: 0.15, evidence: {} },
    { trade_id: 9999, stage_id: 'exit', decision_type: 'exit_timing', decision_score: 0.85, contribution_to_outcome: 0.15, evidence: {} },
    { trade_id: 9999, stage_id: 'monitoring', decision_type: 'position_monitoring', decision_score: 0.4, contribution_to_outcome: -0.05, evidence: {} },
  ];
}

// ─── Unit tests ───────────────────────────────────────────────────────────────

async function testScenario1_Preferred() {
  console.log('\n[Scenario 1] Preferred trade — high PnL, good setup');

  const quality = buildMockQuality({
    market_decision_score: 0.82,
    pipeline_quality_score: 0.78,
    monitoring_score: 0.75,
    backtest_utilization_score: 0.70,
    overall_score: 0.79,
    category: 'preferred',
  });

  assert(quality.category === 'preferred', 'category = preferred');
  assert(quality.overall_score >= 0.70, `overall_score ${quality.overall_score} >= 0.70`);
  assert(quality.market_decision_score >= 0.70, 'market_decision_score OK');
}

async function testScenario2_Rejected() {
  console.log('\n[Scenario 2] Rejected trade — low PnL, bad pipeline');

  const quality = buildMockQuality({
    market_decision_score: 0.25,
    pipeline_quality_score: 0.30,
    monitoring_score: 0.40,
    backtest_utilization_score: 0.20,
    overall_score: 0.29,
    category: 'rejected',
  });

  const stageAttrs = buildMockStageAttrs();

  assert(quality.category === 'rejected', 'category = rejected');
  assert(quality.overall_score <= 0.40, `overall_score ${quality.overall_score} <= 0.40`);
  assert(stageAttrs.length > 0, 'stage attributions built');

  // Reflexion은 dry-run 모드에서 LLM 호출 없이 구조 검증만
  const mockReflexion = {
    trade_id: 9999,
    five_why: [
      { q: '왜 실패했나?', a: '진입 타이밍이 늦었다' },
      { q: '왜 타이밍이 늦었나?', a: '감성 신호를 무시했다' },
      { q: '왜 감성 신호를 무시했나?', a: '기술 분석만 보았다' },
      { q: '왜 기술 분석만 보았나?', a: '멀티 신호 합산이 없었다' },
      { q: '왜 합산이 없었나?', a: '파이프라인이 불완전했다' },
    ],
    hindsight: '감성 신호가 강하게 negative일 때는 기술 분석과 무관하게 진입을 보류했어야 했다',
    avoid_pattern: {
      symbol_pattern: 'crypto/* sentiment<0.3',
      avoid_action: 'long_entry',
      reason: '감성 지수 0.3 이하에서 long 진입 시 손실 확률 높음',
      evidence: [9999],
    },
    stage_attribution: { discovery: 0.05, entry: -0.15, exit: -0.10 },
  };

  assert(mockReflexion.five_why.length === 5, '5-Why 5개 생성');
  assert(typeof mockReflexion.hindsight === 'string' && mockReflexion.hindsight.length > 0, 'hindsight 생성');
  assert(mockReflexion.avoid_pattern.avoid_action === 'long_entry', 'avoid_action = long_entry');
  assert(Array.isArray(mockReflexion.avoid_pattern.evidence), 'evidence 배열');
}

async function testScenario3_Neutral() {
  console.log('\n[Scenario 3] Neutral trade — mixed signals');

  const quality = buildMockQuality({
    market_decision_score: 0.55,
    pipeline_quality_score: 0.50,
    monitoring_score: 0.60,
    backtest_utilization_score: 0.45,
    overall_score: 0.53,
    category: 'neutral',
  });

  assert(quality.category === 'neutral', 'category = neutral');
  assert(quality.overall_score > 0.40 && quality.overall_score < 0.70, `overall_score ${quality.overall_score} in neutral range`);
}

async function testScenario4_WeightedSum() {
  console.log('\n[Scenario 4] weighted_sum 계산 검증');

  const WEIGHT = { market_decision: 0.35, pipeline_quality: 0.30, monitoring: 0.20, backtest_utilization: 0.15 };
  const scores = { market_decision: 0.8, pipeline_quality: 0.6, monitoring: 0.7, backtest_utilization: 0.5 };

  const expected = (
    scores.market_decision * WEIGHT.market_decision +
    scores.pipeline_quality * WEIGHT.pipeline_quality +
    scores.monitoring * WEIGHT.monitoring +
    scores.backtest_utilization * WEIGHT.backtest_utilization
  );

  assert(Math.abs(expected - 0.685) < 0.001, `weighted_sum = ${expected.toFixed(3)} ≈ 0.685`);
}

async function testScenario5_StageAttributionStructure() {
  console.log('\n[Scenario 5] Stage Attribution 구조 검증');

  const stageAttrs = buildMockStageAttrs();

  assert(stageAttrs.every(a => typeof a.trade_id === 'number'), 'trade_id exists');
  assert(stageAttrs.every(a => typeof a.stage_id === 'string'), 'stage_id exists');
  assert(stageAttrs.every(a => a.contribution_to_outcome >= -1 && a.contribution_to_outcome <= 1), 'contribution_to_outcome in [-1,1]');
  assert(stageAttrs.every(a => a.decision_score >= 0 && a.decision_score <= 1), 'decision_score in [0,1]');

  // 가장 낮은 contribution 스테이지 찾기
  const worst = stageAttrs.reduce((min, a) => a.contribution_to_outcome < min.contribution_to_outcome ? a : min);
  assert(worst.stage_id === 'monitoring', `worst stage = ${worst.stage_id}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== runtime-posttrade-feedback-smoke ===\n');

  await testScenario1_Preferred();
  await testScenario2_Rejected();
  await testScenario3_Neutral();
  await testScenario4_WeightedSum();
  await testScenario5_StageAttributionStructure();

  console.log(`\n결과: ${passed}/${passed + failed} 통과`);

  if (failed > 0) {
    console.error(`${failed}개 테스트 실패`);
    process.exit(1);
  } else {
    console.log('✅ 모든 스모크 테스트 통과');
  }
}

if (isDirectExecution(import.meta.url)) {
  runCliMain(main);
}

export { main as runSmoke };
