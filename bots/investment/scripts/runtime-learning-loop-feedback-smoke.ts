#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildLearningLoopFeedbackState,
  summarizeValidationExecution,
} from './runtime-learning-loop-report.ts';

function validation({ findings = 0, paperOnly = false, liveFindings = 0, paperFindings = 0 } = {}) {
  return {
    findings,
    closedTrades: 10,
    summary: {
      topIssue: findings > 0 ? { key: 'missing_review', count: findings } : null,
      topSymbol: findings > 0 ? { key: 'ANKR/USDT', count: 2 } : null,
      liveFindings,
      paperFindings,
      paperOnly,
      repairCommand: paperOnly
        ? 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run validate-review:repair:paper'
        : 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run validate-review:repair',
      recheckCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run validate-review -- --days=90',
    },
  };
}

export function runRuntimeLearningLoopFeedbackSmoke() {
  const now = new Date();

  const paperArchive = buildLearningLoopFeedbackState({
    validation: validation({ findings: 54, paperOnly: true, liveFindings: 0, paperFindings: 54 }),
    freshness: { latestTradeReviewAt: now },
  });
  assert.equal(paperArchive.status, 'paper_archive');
  assert.equal(paperArchive.validationRepairCloseout.status, 'trade_review_repair_dry_run');
  assert.match(paperArchive.headline, /live 피드백 루프를 막지 않는/);
  assert.match(paperArchive.headline, /live 0 \/ paper 54/);

  const liveRepair = buildLearningLoopFeedbackState({
    validation: validation({ findings: 2, paperOnly: false, liveFindings: 1, paperFindings: 1 }),
    freshness: { latestTradeReviewAt: now },
  });
  assert.equal(liveRepair.status, 'repair');
  assert.match(liveRepair.validationRepairCloseout.actionItems[0], /validate-review:repair/);

  const active = buildLearningLoopFeedbackState({
    validation: validation({ findings: 0 }),
    freshness: { latestTradeReviewAt: now },
  });
  assert.equal(active.status, 'active');

  const idle = buildLearningLoopFeedbackState({
    validation: validation({ findings: 0 }),
    freshness: { latestTradeReviewAt: null },
  });
  assert.equal(idle.status, 'idle');

  const validationExecution = summarizeValidationExecution({
    summary: {},
  }, {
    validationSummary: {
      crypto: { decision: 0, approved: 25, executed: 25 },
      domestic: { decision: 0, approved: 1, executed: 1 },
      overseas: { decision: 0, approved: 0, executed: 0 },
    },
  });
  assert.equal(validationExecution.decisions, 0);
  assert.equal(validationExecution.approved, 26);
  assert.equal(validationExecution.executed, 26);

  return {
    ok: true,
    statuses: {
      paperArchive: paperArchive.status,
      liveRepair: liveRepair.status,
      active: active.status,
      idle: idle.status,
    },
    validationExecution,
  };
}

async function main() {
  const result = runRuntimeLearningLoopFeedbackSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('runtime learning loop feedback smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime learning loop feedback smoke 실패:',
  });
}
