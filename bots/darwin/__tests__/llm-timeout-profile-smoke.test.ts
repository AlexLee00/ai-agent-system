'use strict';

const assert = require('assert');

const timeout = require('../lib/llm-timeout-profile.ts');

function main() {
  assert.strictEqual(timeout.getDarwinTimeoutTier('short'), 25_000);
  assert.strictEqual(timeout.getDarwinTimeoutTier('medium'), 45_000);
  assert.strictEqual(timeout.getDarwinTimeoutTier('long'), 120_000);
  assert.strictEqual(timeout.getDarwinLlmTimeout('evaluator'), 25_000);
  assert.strictEqual(timeout.getDarwinLlmTimeout('edison_synthesis'), 120_000);
  assert.strictEqual(timeout.getDarwinLlmTimeout('implementation'), 45_000);
  assert.strictEqual(timeout.getDarwinLlmTimeout('skill_generation'), 45_000);
  assert.strictEqual(timeout.readDarwinTimeoutOverride('NO_SUCH_ENV', 120_000, {}), 120_000);
  assert.strictEqual(timeout.readDarwinTimeoutOverride('T', 120_000, { T: '1000' }, { minMs: 30_000, maxMs: 180_000 }), 30_000);
  assert.strictEqual(timeout.readDarwinTimeoutOverride('T', 120_000, { T: '999999' }, { minMs: 30_000, maxMs: 180_000 }), 180_000);
  console.log('✅ darwin llm timeout profile smoke ok');
}

main();
