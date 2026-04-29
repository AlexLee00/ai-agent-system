#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import dbDefault, * as facade from '../shared/db.ts';
import * as core from '../shared/db/core.ts';
import * as signals from '../shared/db/signals.ts';
import * as trades from '../shared/db/trades.ts';
import * as positions from '../shared/db/positions.ts';
import * as screening from '../shared/db/screening.ts';
import * as posttrade from '../shared/db/posttrade.ts';

const checks = [
  ['core.query.named', facade.query === core.query],
  ['core.query.default', dbDefault.query === core.query],
  ['signals.insertSignal.named', facade.insertSignal === signals.insertSignal],
  ['signals.insertSignal.default', dbDefault.insertSignal === signals.insertSignal],
  ['signals.insertSignalIfFresh.default', dbDefault.insertSignalIfFresh === signals.insertSignalIfFresh],
  ['signals.mergeSignalBlockMeta.default', dbDefault.mergeSignalBlockMeta === signals.mergeSignalBlockMeta],
  ['trades.insertTrade.default', dbDefault.insertTrade === trades.insertTrade],
  ['positions.upsertPosition.default', dbDefault.upsertPosition === positions.upsertPosition],
  ['positions.deletePositionsForExchangeScope.default', dbDefault.deletePositionsForExchangeScope === positions.deletePositionsForExchangeScope],
  ['screening.dynamicSymbols.default', dbDefault.getRecentScreeningDynamicSymbols === screening.getRecentScreeningDynamicSymbols],
  ['screening.markets.default', dbDefault.getRecentScreeningMarkets === screening.getRecentScreeningMarkets],
  ['posttrade.cleanupSmokeArtifacts.default', dbDefault.cleanupPosttradeSmokeArtifacts === posttrade.cleanupPosttradeSmokeArtifacts],
  ['close.default', typeof dbDefault.close === 'function'],
];

const failed = checks.filter(([, ok]) => !ok);
assert.equal(failed.length, 0, `db facade compatibility failed: ${failed.map(([name]) => name).join(', ')}`);

const payload = {
  ok: true,
  smoke: 'db-facade-compatibility',
  checks: Object.fromEntries(checks),
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('db-facade-compatibility-smoke ok');
}
