#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const {
  DEFAULT_BLOG_WRITER_MODEL,
  resolveBlogWriterModel,
  isBlogAbStrictFamilyEnabled,
  writerModelFamily,
  buildWriterFamilyRequestOptions,
} = require('../lib/writer-model-policy.ts');
const { _testOnly: bloTest } = require('../lib/blo.ts');
const unified = require('../../hub/lib/llm/unified-caller.ts');
const {
  estimateProviderForPost,
  summarizePollutedRoutingLogs,
  routeFamily,
} = require('./blog-ab-provider-backfill.ts');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

async function main() {
  const oldWriterModel = process.env.BLOG_WRITER_MODEL;
  const oldStrict = process.env.BLOG_AB_STRICT_FAMILY;
  const oldSonnetDisabled = process.env.LLM_CLAUDE_CODE_SONNET_DISABLED;

  try {
    delete process.env.BLOG_WRITER_MODEL;
    delete process.env.BLOG_AB_STRICT_FAMILY;
    assert.equal(resolveBlogWriterModel(), DEFAULT_BLOG_WRITER_MODEL);
    assert.equal(isBlogAbStrictFamilyEnabled(), false, 'strict family must default off');
    assert.deepEqual(buildWriterFamilyRequestOptions('anthropic_sonnet'), {});
    assert.equal(writerModelFamily('anthropic_sonnet'), 'anthropic');
    assert.equal(routeFamily('openai-oauth/gpt-5.4'), 'openai');

    process.env.BLOG_AB_STRICT_FAMILY = 'true';
    assert.deepEqual(buildWriterFamilyRequestOptions('anthropic_sonnet'), { strictProviderFamily: 'anthropic' });

    const baseChain = {
      selectorKey: 'blog.gems.writer',
      chain: [
        { provider: 'claude-code', model: 'sonnet' },
        { provider: 'openai-oauth', model: 'gpt-5.4' },
      ],
    };
    delete process.env.LLM_CLAUDE_CODE_SONNET_DISABLED;
    const strict = unified._testOnly._applyStrictProviderFamily({ abstractModel: 'anthropic_sonnet', strictProviderFamily: 'anthropic' }, baseChain);
    assert.equal(strict.chain.length, 1);
    assert.equal(unified._testOnly._routeProviderFamily(strict.chain[0], 'anthropic_sonnet'), 'anthropic');

    process.env.LLM_CLAUDE_CODE_SONNET_DISABLED = 'true';
    const strictWithClaudeDisabled = unified._testOnly._applyStrictProviderFamily({ abstractModel: 'anthropic_sonnet', strictProviderFamily: 'anthropic' }, baseChain);
    assert.equal(strictWithClaudeDisabled.chain.length, 0, 'strict family must not allow OpenAI sonnet replacement');
    assert.match(strictWithClaudeDisabled.error, /strict_provider_family_unavailable/);

    const metadata = bloTest.buildWriterAbMetadata({
      writerModel: 'anthropic_sonnet',
      usedModel: 'openai-oauth/gpt-5.4',
      fallbackUsed: true,
      traceId: 'trace-smoke',
    });
    assert.deepEqual(metadata, {
      writer_model: 'anthropic_sonnet',
      served_model: 'openai-oauth/gpt-5.4',
      fallback_used: true,
      trace_id: 'trace-smoke',
    });

    const post = {
      id: 7,
      title: 'A/B test post',
      post_type: 'general',
      created_at: '2026-07-06T12:00:00.000Z',
      metadata: { writer_model: 'anthropic_sonnet' },
    };
    const estimate = estimateProviderForPost(post, [{
      created_at: '2026-07-06T12:03:00.000Z',
      provider: 'openai-oauth',
      agent: 'gems',
      caller_team: 'blog',
      abstract_model: 'anthropic_sonnet',
      selected_route: 'openai-oauth/gpt-5.4',
      fallback_count: 1,
      selector_key: 'blog.gems.writer',
    }], { windowMinutes: 90 });
    assert.equal(estimate.polluted, true);
    assert.equal(estimate.served_model, 'openai-oauth/gpt-5.4');
    const pollutedLogs = summarizePollutedRoutingLogs([
      {
        created_at: '2026-07-06T12:03:00.000Z',
        provider: 'openai-oauth',
        agent: 'gems',
        abstract_model: 'anthropic_sonnet',
        selected_route: 'openai-oauth/gpt-5.4',
        fallback_count: 1,
        selector_key: 'blog.gems.writer',
      },
      {
        created_at: '2026-07-06T12:03:00.000Z',
        provider: 'openai-oauth',
        agent: 'gems',
        abstract_model: 'anthropic_sonnet',
        selected_route: 'openai-oauth/gpt-5.4',
        fallback_count: 1,
        selector_key: 'blog.gems.writer',
      },
    ]);
    assert.equal(pollutedLogs.length, 1, 'routing-log pollution summary must dedupe duplicate inserts');

    const gems = read('lib/gems-writer.ts');
    const pos = read('lib/pos-writer.ts');
    const chunked = fs.readFileSync(path.join(ROOT, '../../packages/core/lib/chunked-llm.ts'), 'utf8');
    assert.ok(gems.includes('buildWriterFamilyRequestOptions(writerModel)'), 'gems writer must pass strict family options');
    assert.ok(pos.includes('buildWriterFamilyRequestOptions(writerModel)'), 'pos writer must pass strict family options');
    assert.ok(gems.includes('+continue:'), 'gems continuation route must be reflected in served model');
    assert.ok(pos.includes('+continue:'), 'pos continuation route must be reflected in served model');
    assert.ok(chunked.includes('strictProviderFamily'), 'chunked writer must forward strict family options');

    console.log(JSON.stringify({
      ok: true,
      metadata,
      strictChainLength: strict.chain.length,
      disabledClaudeChainLength: strictWithClaudeDisabled.chain.length,
      pollutedRoutingLogs: pollutedLogs.length,
      pollutedEstimate: estimate,
    }, null, 2));
  } finally {
    if (oldWriterModel == null) delete process.env.BLOG_WRITER_MODEL;
    else process.env.BLOG_WRITER_MODEL = oldWriterModel;
    if (oldStrict == null) delete process.env.BLOG_AB_STRICT_FAMILY;
    else process.env.BLOG_AB_STRICT_FAMILY = oldStrict;
    if (oldSonnetDisabled == null) delete process.env.LLM_CLAUDE_CODE_SONNET_DISABLED;
    else process.env.LLM_CLAUDE_CODE_SONNET_DISABLED = oldSonnetDisabled;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
