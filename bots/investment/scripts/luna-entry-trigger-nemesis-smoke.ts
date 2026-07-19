#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { materializeFiredEntryTriggerSignals } from './luna-entry-trigger-worker.ts';
import { normalizeNemesisLlmDecision } from '../team/nemesis.ts';

function makeTrigger(id = 'entry-trigger-smoke') {
  return {
    id,
    symbol: 'BTC/USDT',
    exchange: 'binance',
    setup_type: 'breakout_confirmation',
    trigger_type: 'breakout_confirmation',
    trigger_state: 'fired',
    confidence: 0.82,
    trigger_context: {
      strategyRoute: {
        selectedFamily: 'trend_following',
        setupType: 'breakout_confirmation',
        quality: 'ready',
        readinessScore: 0.84,
        hasTechnicalPresignal: true,
        externalEvidence: {
          evidenceCount: 3,
          sourceCount: 2,
          avgQuality: 0.8,
          avgFreshness: 0.9,
        },
      },
    },
    trigger_meta: {},
  };
}

function makeDeps(overrides = {}) {
  const inserted = [];
  const updated = [];
  const evaluated = [];
  return {
    inserted,
    updated,
    evaluated,
    deps: {
      binanceTopVolumeUniverse: {
        source: 'smoke',
        limit: 30,
        symbols: ['BTC/USDT'],
        ranks: { 'BTC/USDT': 1 },
      },
      tradeDataHygieneBuilder: async () => ({
        ok: true,
        status: 'ready',
        severity: 'none',
        blockers: [],
      }),
      triggerFetcher: async (id) => makeTrigger(id),
      duplicateFinder: async () => null,
      entryPreflightShadowRunner: async () => ({ enabled: false, reason: 'smoke' }),
      entryPreflightShadowAttacher: async () => null,
      riskEvaluator: async (signal, options) => {
        evaluated.push({ signal, options });
        return {
          approved: true,
          adjustedAmount: 37,
          nemesis_verdict: 'modified',
          approved_at: '2026-07-19T00:00:00.000Z',
        };
      },
      signalInserter: async (payload) => {
        inserted.push(payload);
        return 'signal-smoke';
      },
      blockMetaMerger: async () => null,
      triggerUpdater: async (id, patch) => {
        updated.push({ id, patch });
      },
      ...overrides,
    },
  };
}

async function runMaterialize(deps) {
  return materializeFiredEntryTriggerSignals({
    exchange: 'binance',
    result: {
      allowLiveFire: true,
      results: [{ triggerId: 'entry-trigger-smoke', symbol: 'BTC/USDT', fired: true }],
    },
    riskContext: {
      capitalSnapshot: {
        mode: 'ACTIVE_DISCOVERY',
        totalAsset: 1000,
        buyableAmount: 500,
        minOrderAmount: 10,
        remainingSlots: 2,
      },
    },
    events: [{ symbol: 'BTC/USDT', price: 100, targetPrice: 100 }],
    deps,
  });
}

async function main() {
  assert.equal(normalizeNemesisLlmDecision('not-json').decision, 'REJECT', 'malformed risk LLM output must fail closed');
  assert.equal(normalizeNemesisLlmDecision('{"decision":"ADJUST"}').decision, 'REJECT', 'ADJUST without a valid amount must fail closed');
  assert.equal(normalizeNemesisLlmDecision('{"decision":"approve","reasoning":"ok"}').decision, 'APPROVE');

  const approved = makeDeps();
  const approvedResult = await runMaterialize(approved.deps);
  assert.equal(approved.evaluated.length, 1, 'entry trigger must pass through Nemesis before insert');
  assert.equal(approved.evaluated[0].signal.amount_usdt, 500);
  assert.equal(approved.evaluated[0].options.persist, false);
  assert.equal(approved.inserted.length, 1);
  assert.equal(approved.inserted[0].amountUsdt, 37, 'Nemesis-adjusted amount must be persisted');
  assert.equal(approved.inserted[0].nemesisVerdict, 'modified');
  assert.equal(approved.inserted[0].approvedAt, '2026-07-19T00:00:00.000Z');
  assert.equal(approvedResult.materialized, 1);

  const rejected = makeDeps({
    riskEvaluator: async () => ({
      approved: false,
      adjustedAmount: 0,
      nemesis_verdict: 'rejected',
      reason: 'smoke_risk_rejected',
    }),
  });
  const rejectedResult = await runMaterialize(rejected.deps);
  assert.equal(rejected.inserted.length, 0, 'rejected entry trigger must never insert an approved signal');
  assert.equal(rejectedResult.materialized, 0);
  assert.equal(rejectedResult.skipped, 1);
  assert.equal(rejectedResult.items[0].reason, 'entry_trigger_nemesis_rejected');
  assert.ok(rejected.updated.some((item) => item.patch?.triggerMetaPatch?.materializeStatus === 'blocked_by_nemesis'));
  assert.ok(rejected.updated.some((item) => item.patch?.triggerMetaPatch?.materializeTerminal === true), 'Nemesis rejection must not be retried every scheduler cycle');

  const malformed = makeDeps({
    riskEvaluator: async () => ({ approved: true, adjustedAmount: 50 }),
  });
  const malformedResult = await runMaterialize(malformed.deps);
  assert.equal(malformed.inserted.length, 0, 'missing Nemesis approval metadata must fail closed');
  assert.equal(malformedResult.items[0].reason, 'entry_trigger_nemesis_invalid_approval');
  assert.ok(malformed.updated.some((item) => item.patch?.triggerMetaPatch?.materializeTerminalReason === 'entry_trigger_nemesis_invalid_approval'));

  const originalMaxRetries = process.env.LUNA_ENTRY_TRIGGER_NEMESIS_MAX_RETRIES;
  process.env.LUNA_ENTRY_TRIGGER_NEMESIS_MAX_RETRIES = '2';
  try {
    const retryable = makeDeps({ riskEvaluator: async () => { throw new Error('temporary_timeout'); } });
    await runMaterialize(retryable.deps);
    const retryPatch = retryable.updated.find((item) => item.patch?.triggerMetaPatch?.materializeStatus === 'nemesis_retry_pending')?.patch?.triggerMetaPatch;
    assert.equal(retryPatch?.materializeTerminal, false, 'a transient Nemesis error should remain retryable');
    assert.equal(retryPatch?.nemesisRetryCount, 1);
    assert.ok(retryPatch?.materializeNextRetryAt);

    const exhausted = makeDeps({
      triggerFetcher: async (id) => ({ ...makeTrigger(id), trigger_meta: { nemesisRetryCount: 1 } }),
      riskEvaluator: async () => { throw new Error('temporary_timeout'); },
    });
    await runMaterialize(exhausted.deps);
    const exhaustedPatch = exhausted.updated.find((item) => item.patch?.triggerMetaPatch?.materializeTerminal === true)?.patch?.triggerMetaPatch;
    assert.equal(exhaustedPatch?.materializeStatus, 'blocked_by_nemesis_error_exhausted');
    assert.equal(exhaustedPatch?.nemesisRetryCount, 2);
  } finally {
    if (originalMaxRetries == null) delete process.env.LUNA_ENTRY_TRIGGER_NEMESIS_MAX_RETRIES;
    else process.env.LUNA_ENTRY_TRIGGER_NEMESIS_MAX_RETRIES = originalMaxRetries;
  }

  console.log(JSON.stringify({
    ok: true,
    approved: approvedResult,
    rejected: rejectedResult,
    malformed: malformedResult,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
