#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { buildPositionStrategyHygieneDecision } from './runtime-position-strategy-hygiene.ts';

const attention = buildPositionStrategyHygieneDecision({
  audit: {
    duplicateManagedProfileScopes: 2,
    orphanProfiles: 3,
    unmatchedManagedPositions: 1,
  },
  duplicateNormalization: {
    rows: [
      { exchange: 'kis_overseas', retirements: [{}, {}] },
    ],
    decision: {
      headline: '동일 종목 active strategy profile 정규화 후보 2개 scope가 있습니다.',
    },
  },
  orphanRetirement: {
    rows: [
      { exchange: 'kis_overseas' },
      { exchange: 'kis_overseas' },
      { exchange: 'kis_overseas' },
    ],
    decision: {
      headline: 'live 포지션이 없는 active strategy profile 3건이 있습니다.',
    },
  },
});

assert.equal(attention.status, 'position_strategy_hygiene_attention');
assert.match(attention.actionItems.join('\n'), /duplicate scopes 2/);
assert.match(attention.headline, /focus kis_overseas/);

const ok = buildPositionStrategyHygieneDecision({
  audit: {
    duplicateManagedProfileScopes: 0,
    orphanProfiles: 0,
    unmatchedManagedPositions: 0,
  },
});

assert.equal(ok.status, 'position_strategy_hygiene_ok');

console.log('runtime position strategy hygiene smoke ok');
