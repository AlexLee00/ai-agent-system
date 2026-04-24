#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { buildPhase6FeedbackSuggestions } from './runtime-phase6-feedback-suggestions.ts';
import { computeRegimePolicy } from '../shared/regime-strategy-policy.ts';

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) { console.log(`  ✅ ${label}`); passed++; }
  else { console.error(`  ❌ ${label}`); failed++; }
}

async function main() {
  console.log('🧪 runtime-phase6-feedback-suggestions smoke test');
  await db.initSchema();

  // 1. buildPhase6FeedbackSuggestions 기본 실행
  const result = await buildPhase6FeedbackSuggestions({ days: 30, minSamples: 3 });
  assert('buildPhase6FeedbackSuggestions ok', result.ok === true);
  assert('status 존재', ['waiting_samples', 'no_suggestions', 'has_suggestions'].includes(result.status));
  assert('allowSuggestions 배열', Array.isArray(result.allowSuggestions));
  assert('escalateSuggestions 배열', Array.isArray(result.escalateSuggestions));

  // 2. computeRegimePolicy — 4가지 regime 테스트
  const bull = computeRegimePolicy({ market: 'crypto', regime: 'trending_bull', setupType: 'trend_following' });
  const bear = computeRegimePolicy({ market: 'crypto', regime: 'trending_bear', setupType: 'mean_reversion' });
  const vol = computeRegimePolicy({ market: 'crypto', regime: 'volatile', setupType: 'breakout' });
  const rang = computeRegimePolicy({ market: 'stock', regime: 'ranging', setupType: 'unknown' });

  assert('bull: stopLoss > bear stopLoss', bull.stopLossPct > bear.stopLossPct);
  assert('bear: partialExitRatioBias > bull', bear.partialExitRatioBias > bull.partialExitRatioBias);
  assert('vol: cadenceMs < bull cadenceMs', vol.cadenceMs <= bull.cadenceMs);
  assert('bull policyMode=aggressive', bull.policyMode === 'aggressive');
  assert('bear policyMode=defensive', bear.policyMode === 'defensive');
  assert('rang market=stock', rang.market === 'stock');
  assert('rang reevaluationWindow >= 60', rang.reevaluationWindowMinutes >= 60);

  // 3. feedback 조정 테스트
  const withDownweight = computeRegimePolicy({
    market: 'crypto', regime: 'ranging', familyBias: 'downweight_by_pnl',
    closeoutAvgPnlPercent: -4, closeoutWinRate: 0.3,
  });
  const base = computeRegimePolicy({ market: 'crypto', regime: 'ranging' });
  assert('downweight: partialExitRatioBias 증가', withDownweight.partialExitRatioBias > base.partialExitRatioBias);
  assert('low winRate: reentryLock=true', withDownweight.reentryLock === true);

  // 4. sourceQuality 낮음 → blocked
  const lowQuality = computeRegimePolicy({ market: 'crypto', regime: 'ranging', sourceQualityScore: 0.3 });
  assert('sourceQuality < 0.4 → sourceQualityBlocked', lowQuality.sourceQualityBlocked === true);

  // 5. 수치 범위 검증
  assert('stopLossPct 범위 [0.01, 0.3]', bull.stopLossPct >= 0.01 && bull.stopLossPct <= 0.3);
  assert('profitLockPct 범위 [0.02, 0.5]', bear.profitLockPct >= 0.02 && bear.profitLockPct <= 0.5);
  assert('partialExitRatioBias 범위 [0.5, 2.5]', bear.partialExitRatioBias >= 0.5 && bear.partialExitRatioBias <= 2.5);
  assert('cadenceMs 범위 [5000, 60000]', bear.cadenceMs >= 5000 && bear.cadenceMs <= 60000);

  console.log('');
  console.log(`결과: ${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
}

await main();
