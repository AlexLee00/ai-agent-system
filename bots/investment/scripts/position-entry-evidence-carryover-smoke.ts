#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildEntryEvidenceContext,
  resolveEntryEvidenceCarryover,
} from '../shared/position-entry-evidence-carryover.ts';

const seedSignal = {
  id: 'sig-entry-001',
  confidence: 0.62,
  reasoning: 'daily trend and liquidity aligned',
  analyst_signals: 'A:B|O:B|H:H|S:B',
  block_meta: {
    entryTrigger: {
      state: 'fired',
      triggerType: 'mtf_alignment',
      predictiveScore: 0.58,
    },
    predictiveValidation: {
      mode: 'hard_gate',
      score: 0.58,
    },
    scoreFusion: {
      discoveryScore: 0.71,
    },
  },
};

const context = buildEntryEvidenceContext({
  decision: {
    action: 'BUY',
    confidence: 0.62,
    reasoning: 'daily trend and liquidity aligned',
  },
  seedSignal,
  strategy: {
    summary: 'equity swing from daily trend',
    entry_condition: 'daily trend confirmation',
    setup_type: 'equity_swing',
  },
  strategyRoute: {
    setupType: 'equity_swing',
  },
});

assert.equal(context.entryEvidenceSummary.source, 'entry_signal_snapshot');
assert.equal(context.entryEvidenceSummary.warning, null);
assert.ok(context.entryEvidenceSummary.evidenceCount >= 4);
assert.ok(context.entryEvidenceSummary.qualityScore > 0.6);
assert.equal(context.entryThesisSnapshot.signalId, 'sig-entry-001');

const carryover = resolveEntryEvidenceCarryover({
  externalEvidenceSummary: { evidenceCount: 0, qualityScore: 0.5, warning: 'no external evidence' },
  strategyProfile: {
    strategy_context: context,
  },
  heldHours: 0.25,
});

assert.equal(carryover.usedCarryover, true);
assert.equal(carryover.reason, 'external_evidence_empty_entry_snapshot_carryover');
assert.equal(carryover.summary.carriedFromEntry, true);
assert.equal(carryover.summary.warning, null);
assert.ok(carryover.summary.evidenceCount >= 4);

const seedOnlyCarryover = resolveEntryEvidenceCarryover({
  externalEvidenceSummary: { evidenceCount: 0, qualityScore: 0.5, warning: 'no external evidence' },
  seedSignal,
  heldHours: 0.25,
});

assert.equal(seedOnlyCarryover.usedCarryover, true);
assert.equal(seedOnlyCarryover.summary.carriedFromEntry, true);
assert.ok(seedOnlyCarryover.summary.evidenceCount >= 3);

const externalWins = resolveEntryEvidenceCarryover({
  externalEvidenceSummary: { evidenceCount: 2, qualityScore: 0.44, warning: null },
  strategyProfile: {
    strategy_context: context,
  },
  heldHours: 0.25,
});

assert.equal(externalWins.usedCarryover, false);
assert.equal(externalWins.reason, 'external_evidence_available');
assert.equal(externalWins.summary.evidenceCount, 2);

const expired = resolveEntryEvidenceCarryover({
  externalEvidenceSummary: { evidenceCount: 0, qualityScore: 0.5, warning: 'no external evidence' },
  strategyProfile: {
    strategy_context: context,
  },
  heldHours: 48,
});

assert.equal(expired.usedCarryover, false);
assert.equal(expired.reason, 'entry_evidence_expired');

console.log(JSON.stringify({
  ok: true,
  status: 'position_entry_evidence_carryover_ok',
  evidenceCount: context.entryEvidenceSummary.evidenceCount,
  qualityScore: context.entryEvidenceSummary.qualityScore,
}, null, 2));
