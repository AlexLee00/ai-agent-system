#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  explainPriorityRuntimeSuggestion,
  selectPriorityRuntimeSuggestion,
} from './runtime-learning-loop-report.ts';

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
  const outcomeAdjustPriority = explainPriorityRuntimeSuggestion({
    suggestions: [regimeMatched, riskOutcomeAdjust],
  }, regimePerformance());
  assert.equal(outcomeAdjustPriority.selected, riskOutcomeAdjust);
  assert.equal(outcomeAdjustPriority.category, 'risk_approval_outcome_adjust');
  assert.match(outcomeAdjustPriority.reason, /사후 성과/);

  const outcomeReviewWins = selectPriorityRuntimeSuggestion({
    suggestions: [regimeMatched, riskOutcomeModelReview],
  }, regimePerformance());
  assert.equal(outcomeReviewWins, riskOutcomeModelReview);
  const outcomeReviewPriority = explainPriorityRuntimeSuggestion({
    suggestions: [regimeMatched, riskOutcomeModelReview],
  }, regimePerformance());
  assert.equal(outcomeReviewPriority.category, 'risk_approval_model_outcome_review');

  const regimeMatchWins = selectPriorityRuntimeSuggestion({
    suggestions: [genericAdjust, regimeMatched],
  }, regimePerformance());
  assert.equal(regimeMatchWins, regimeMatched);
  const regimeMatchPriority = explainPriorityRuntimeSuggestion({
    suggestions: [genericAdjust, regimeMatched],
  }, regimePerformance());
  assert.equal(regimeMatchPriority.category, 'weakest_regime_match');

  const fallbackAdjustWins = selectPriorityRuntimeSuggestion({
    suggestions: [suggestion('runtime_config.foo.watch', 'watch'), genericAdjust],
  }, regimePerformance('sideways', 'normal'));
  assert.equal(fallbackAdjustWins, genericAdjust);
  const fallbackAdjustPriority = explainPriorityRuntimeSuggestion({
    suggestions: [suggestion('runtime_config.foo.watch', 'watch'), genericAdjust],
  }, regimePerformance('sideways', 'normal'));
  assert.equal(fallbackAdjustPriority.category, 'generic_adjust');

  const empty = selectPriorityRuntimeSuggestion({ suggestions: [] }, regimePerformance());
  assert.equal(empty, null);
  const emptyPriority = explainPriorityRuntimeSuggestion({ suggestions: [] }, regimePerformance());
  assert.equal(emptyPriority.category, 'empty');

  return {
    ok: true,
    outcomeAdjustWins: outcomeAdjustWins.key,
    outcomeAdjustCategory: outcomeAdjustPriority.category,
    outcomeReviewWins: outcomeReviewWins.key,
    outcomeReviewCategory: outcomeReviewPriority.category,
    regimeMatchWins: regimeMatchWins.key,
    regimeMatchCategory: regimeMatchPriority.category,
    fallbackAdjustWins: fallbackAdjustWins.key,
    fallbackAdjustCategory: fallbackAdjustPriority.category,
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
