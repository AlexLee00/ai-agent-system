#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { selectPriorityRuntimeSuggestion } from './runtime-learning-loop-report.ts';

function suggestion(key, action = 'adjust', reason = '') {
  return { key, action, reason, suggestedValue: 'fixture' };
}

function regimePerformance(regime = 'trending_bear', tradeMode = 'validation') {
  return {
    weakestRegime: {
      regime,
      worstMode: { tradeMode },
    },
  };
}

export function runRiskApprovalLearningLoopSmoke() {
  const regimeMatched = suggestion(
    'runtime_config.execution.cryptoGuardSoftening.byExchange.binance.tradeModes.normal.validationFallback.reductionMultiplier',
    'adjust',
    'trending_bear validation 레인 약화',
  );
  const riskOutcomeAdjust = suggestion(
    'runtime_config.nemesis.riskApprovalChain.assist.maxReductionPct',
    'adjust',
    '리스크 승인 사후 성과 약화',
  );
  const riskOutcomeModelReview = suggestion(
    'runtime_config.nemesis.riskApprovalChain.model.feedback_risk.outcomeReview',
    'promote_candidate',
    '사후 성과 표본 관찰',
  );
  const genericAdjust = suggestion(
    'runtime_config.execution.cryptoGuardSoftening.byExchange.binance.tradeModes.normal.entryMultiplier',
    'adjust',
    '일반 조정 후보',
  );

  const outcomeAdjustWins = selectPriorityRuntimeSuggestion({
    suggestions: [regimeMatched, riskOutcomeAdjust],
  }, regimePerformance());
  assert.equal(outcomeAdjustWins, riskOutcomeAdjust);

  const outcomeReviewWins = selectPriorityRuntimeSuggestion({
    suggestions: [regimeMatched, riskOutcomeModelReview],
  }, regimePerformance());
  assert.equal(outcomeReviewWins, riskOutcomeModelReview);

  const regimeMatchWins = selectPriorityRuntimeSuggestion({
    suggestions: [genericAdjust, regimeMatched],
  }, regimePerformance());
  assert.equal(regimeMatchWins, regimeMatched);

  const fallbackAdjustWins = selectPriorityRuntimeSuggestion({
    suggestions: [suggestion('runtime_config.foo.watch', 'watch'), genericAdjust],
  }, regimePerformance('sideways', 'normal'));
  assert.equal(fallbackAdjustWins, genericAdjust);

  const empty = selectPriorityRuntimeSuggestion({ suggestions: [] }, regimePerformance());
  assert.equal(empty, null);

  return {
    ok: true,
    outcomeAdjustWins: outcomeAdjustWins.key,
    outcomeReviewWins: outcomeReviewWins.key,
    regimeMatchWins: regimeMatchWins.key,
    fallbackAdjustWins: fallbackAdjustWins.key,
  };
}

async function main() {
  const result = runRiskApprovalLearningLoopSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('risk approval learning loop smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ risk approval learning loop smoke 실패:',
  });
}
