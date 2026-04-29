#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import * as db from '../shared/db.ts';
import { buildPosttradeFeedbackActionAudit } from './runtime-posttrade-feedback-action-audit.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function runSmoke() {
  await db.initSchema();
  const sourceTradeId = 900000000 + Math.floor(Math.random() * 99999);
  const parameterName = `runtime_config.posttrade.smoke.${Date.now()}`;
  const log = await db.insertRuntimeConfigSuggestionLog({
    periodDays: 7,
    actionableCount: 1,
    marketSummary: { smoke: true },
    suggestions: [{
      key: parameterName,
      action: 'adjust',
      current: 0.1,
      suggested: 0.2,
      source_trade_ids: [sourceTradeId],
      reason: 'posttrade audit smoke',
    }],
    reviewStatus: 'approved',
    reviewNote: 'posttrade audit smoke',
  });
  assert.ok(log?.id, 'suggestion log inserted');
  await db.updateRuntimeConfigSuggestionLogReview(log.id, {
    reviewStatus: 'applied',
    reviewNote: 'posttrade audit smoke applied',
  });
  const map = await db.insertFeedbackToActionMap({
    sourceTradeId,
    parameterName,
    oldValue: 0.1,
    newValue: 0.2,
    reason: 'posttrade audit smoke',
    suggestionLogId: log.id,
    metadata: { smoke: true },
  });
  assert.ok(map?.id, 'feedback_to_action_map row inserted');

  const audit = await buildPosttradeFeedbackActionAudit({ days: 30, strict: true });
  assert.equal(audit.ok, true, 'audit clear');
  assert.ok(audit.expectedMappings >= 1, 'expected mapping counted');

  return {
    ok: true,
    logId: log.id,
    feedbackMapId: map.id,
    expectedMappings: audit.expectedMappings,
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('feedback-to-action-apply-audit-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ feedback-to-action-apply-audit-smoke 실패:',
  });
}

