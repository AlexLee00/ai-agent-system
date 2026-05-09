#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  createDecisionDebateBudgetGate,
  createDecisionLlmBudgetGate,
  prefilterConfidence,
  resolveDecisionDebateBudget,
  resolveDecisionLlmBudget,
} from '../shared/pipeline-decision-llm-budget.ts';

export async function runPipelineDecisionLlmBudgetSmoke() {
  const cryptoPolicy = resolveDecisionLlmBudget({ exchange: 'binance', env: {} });
  assert.equal(cryptoPolicy.enabled, true);
  assert.equal(cryptoPolicy.maxSymbols, 3);

  const cryptoDebatePolicy = resolveDecisionDebateBudget({ exchange: 'binance', env: {} });
  assert.equal(cryptoDebatePolicy.enabled, true);
  assert.equal(cryptoDebatePolicy.maxSymbols, 1);

  const disabledPolicy = resolveDecisionLlmBudget({
    exchange: 'binance',
    env: { LUNA_CRYPTO_DECISION_LLM_BUDGET_ENABLED: 'false' },
  });
  assert.equal(disabledPolicy.enabled, false);

  const disabledDebatePolicy = resolveDecisionDebateBudget({
    exchange: 'binance',
    env: { LUNA_CRYPTO_DECISION_DEBATE_BUDGET_ENABLED: 'false' },
  });
  assert.equal(disabledDebatePolicy.enabled, false);

  assert.equal(prefilterConfidence({
    technical: { confidence: 0.42 },
    flow: { confidence: 0.61 },
  }), 0.61);

  const gate = createDecisionLlmBudgetGate({
    exchange: 'binance',
    liveHeldSymbols: new Set(['HELD/USDT']),
    env: { LUNA_CRYPTO_DECISION_LLM_MAX_SYMBOLS_PER_CYCLE: '2' },
  });
  assert.equal(gate.allow({ symbol: 'BTC/USDT', prefilter: { technical: { confidence: 0.9 } } }).allow, true);
  assert.equal(gate.allow({ symbol: 'SOL/USDT', prefilter: { technical: { confidence: 0.8 } } }).allow, true);
  const skipped = gate.allow({ symbol: 'LINK/USDT', prefilter: { technical: { confidence: 0.7 } } });
  assert.equal(skipped.allow, false);
  assert.equal(skipped.reason, 'decision_llm_symbol_budget_reached');
  const held = gate.allow({ symbol: 'HELD/USDT', prefilter: { technical: { confidence: 0.2 } } });
  assert.equal(held.allow, true);
  assert.equal(held.reason, 'held_symbol_budget_bypass');

  const snapshot = gate.snapshot();
  assert.equal(snapshot.used, 2);
  assert.equal(snapshot.heldBypass, 1);
  assert.equal(snapshot.skipped, 1);
  assert.deepEqual(snapshot.skippedSymbols.map((item) => item.symbol), ['LINK/USDT']);

  const debateGate = createDecisionDebateBudgetGate({
    exchange: 'binance',
    env: { LUNA_CRYPTO_DECISION_DEBATE_MAX_SYMBOLS_PER_CYCLE: '1' },
  });
  assert.equal(debateGate.allow({ symbol: 'BTC/USDT', prefilter: { technical: { confidence: 0.9 } } }).allow, true);
  const debateSkipped = debateGate.allow({ symbol: 'SOL/USDT', prefilter: { technical: { confidence: 0.8 } } });
  assert.equal(debateSkipped.allow, false);
  assert.equal(debateSkipped.reason, 'decision_debate_budget_reached');
  assert.equal(debateGate.snapshot().skipped, 1);

  return {
    ok: true,
    smoke: 'pipeline-decision-llm-budget',
    defaultCryptoMaxSymbols: cryptoPolicy.maxSymbols,
    defaultCryptoDebateMaxSymbols: cryptoDebatePolicy.maxSymbols,
    skippedReason: skipped.reason,
    debateSkippedReason: debateSkipped.reason,
  };
}

async function main() {
  const result = await runPipelineDecisionLlmBudgetSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('pipeline-decision-llm-budget-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ pipeline-decision-llm-budget-smoke 실패:',
  });
}
