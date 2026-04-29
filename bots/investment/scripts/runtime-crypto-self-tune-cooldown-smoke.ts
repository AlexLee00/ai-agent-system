#!/usr/bin/env node
// @ts-nocheck

import { filterCandidatesByAutoApplyCooldown } from './runtime-crypto-self-tune.ts';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const candidate = {
  key: 'runtime_config.execution.cryptoGuardSoftening.byExchange.binance.tradeModes.validation.livePositionReentry.reductionMultiplier',
  current: 0.45,
  suggested: 0.4,
};
const other = {
  key: 'capital_management.cooldown_minutes',
  current: 10,
  suggested: 15,
};

const result = filterCandidatesByAutoApplyCooldown(
  [candidate, other],
  new Set([candidate.key]),
  24,
);

assert(result.candidates.length === 1, 'recently applied key should be skipped');
assert(result.candidates[0].key === other.key, 'safe unrelated candidate should remain');
assert(result.skippedByCooldown.length === 1, 'skipped candidate should be reported');
assert(result.skippedByCooldown[0].key === candidate.key, 'skipped key should match recent auto apply');
assert(result.skippedByCooldown[0].cooldownHours === 24, 'cooldown hours should be surfaced');

console.log('runtime crypto self tune cooldown smoke ok');
