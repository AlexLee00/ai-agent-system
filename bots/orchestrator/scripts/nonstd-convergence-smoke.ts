#!/usr/bin/env node
// @ts-nocheck

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const selector = require('../../../packages/core/lib/llm-model-selector.ts');

const root = path.resolve(__dirname, '../../..');

function compact(chain) {
  return JSON.stringify(chain.map((entry) => ({
    provider: entry.provider,
    model: entry.model,
    maxTokens: entry.maxTokens || null,
    temperature: entry.temperature ?? null,
  })));
}

function main() {
  const options = { selectorVersion: 'v3.0_oauth_4', rolloutPercent: 100, rolloutKey: 'nonstd-smoke' };
  const jay = selector.selectLLMChain('jay.intent', options);
  const legacyJay = selector.selectLLMChain('orchestrator.jay.intent', options);
  assert.ok(jay.length > 0, 'jay.intent must resolve');
  assert.equal(compact(jay), compact(legacyJay), 'jay.intent must match orchestrator.jay.intent');

  const write = selector.selectLLMChain('write.report', options);
  assert.ok(write.length > 0, 'write.report must resolve');

  const intentSource = fs.readFileSync(path.join(root, 'bots/orchestrator/lib/intent-parser.ts'), 'utf8');
  assert.match(intentSource, /JAY_INTENT_HUB_ENABLED/);
  assert.match(intentSource, /jay\.intent/);
  assert.match(intentSource, /orchestrator\.jay\.intent/);

  const writeSource = fs.readFileSync(path.join(root, 'bots/orchestrator/src/write.ts'), 'utf8');
  assert.match(writeSource, /WRITE_HUB_ENABLED/);
  assert.match(writeSource, /write\.report/);
  assert.match(writeSource, /generateGemmaPilotText/);

  console.log(JSON.stringify({ ok: true, checks: 8 }, null, 2));
}

main();

