#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import * as facade from '../shared/db.ts';
import * as analysis from '../shared/db/analysis.ts';
import * as lifecycle from '../shared/db/lifecycle.ts';
import * as posttrade from '../shared/db/posttrade.ts';
import * as signals from '../shared/db/signals.ts';
import * as trades from '../shared/db/trades.ts';
import * as positions from '../shared/db/positions.ts';
import * as llmRouting from '../shared/db/llm-routing.ts';
import * as risk from '../shared/db/risk.ts';
import * as roles from '../shared/db/roles.ts';
import * as runtimeConfig from '../shared/db/runtime-config.ts';
import * as screening from '../shared/db/screening.ts';
import * as strategy from '../shared/db/strategy.ts';

const checks = [
  ['signals.insertSignal', typeof signals.insertSignal === 'function' && typeof facade.insertSignal === 'function'],
  ['signals.getApprovedSignals', typeof signals.getApprovedSignals === 'function' && typeof facade.getApprovedSignals === 'function'],
  ['trades.insertTrade', typeof trades.insertTrade === 'function' && typeof facade.insertTrade === 'function'],
  ['trades.getLatestTradeBySignalId', typeof trades.getLatestTradeBySignalId === 'function' && typeof facade.getLatestTradeBySignalId === 'function'],
  ['positions.upsertPosition', typeof positions.upsertPosition === 'function' && typeof facade.upsertPosition === 'function'],
  ['positions.getOpenPositions', typeof positions.getOpenPositions === 'function' && typeof facade.getOpenPositions === 'function'],
  ['llmRouting.where', llmRouting.HUB_DISABLED_SMOKE_ARTIFACT_WHERE.includes('direct_fallback')],
  ['llmRouting.list', typeof llmRouting.listHubDisabledSmokeArtifacts === 'function'],
  ['analysis.insertAnalysis', typeof analysis.insertAnalysis === 'function'],
  ['lifecycle.insertLifecycleEvent', typeof lifecycle.insertLifecycleEvent === 'function'],
  ['posttrade.recordFeedbackToActionMap', typeof posttrade.recordFeedbackToActionMap === 'function'],
  ['risk.insertRiskLog', typeof risk.insertRiskLog === 'function'],
  ['roles.getAgentRoleState', typeof roles.getAgentRoleState === 'function'],
  ['runtimeConfig.getRecentRuntimeConfigSuggestionLogs', typeof runtimeConfig.getRecentRuntimeConfigSuggestionLogs === 'function'],
  ['screening.getRecentScreeningSymbols', typeof screening.getRecentScreeningSymbols === 'function'],
  ['strategy.getActiveStrategies', typeof strategy.getActiveStrategies === 'function'],
];

const failed = checks.filter(([, ok]) => !ok);
assert.equal(failed.length, 0, `db domain module smoke failed: ${failed.map(([name]) => name).join(', ')}`);

const payload = {
  ok: true,
  smoke: 'db-domain-modules',
  checks: Object.fromEntries(checks),
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('db-domain-modules-smoke ok');
}
