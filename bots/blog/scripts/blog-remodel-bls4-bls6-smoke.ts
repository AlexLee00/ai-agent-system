#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const {
  DEFAULT_BLOG_WRITER_MODEL,
  resolveBlogWriterModel,
  writerModelCacheSuffix,
} = require('../lib/writer-model-policy.ts');
const {
  buildWriterModelCrankComparison,
} = require('../lib/writer-model-crank-report.ts');
const {
  buildMarketingDisabledResult,
  isBlogMarketingEnabled,
} = require('../lib/marketing-enabled.ts');
const {
  isSnsCrosspostEnabled,
  buildSnsCrosspostDisabledResult,
} = require('../lib/platform-orchestrator.ts');
const {
  recordBlogTelemetry,
  tailBlogTelemetry,
} = require('../lib/blog-telemetry.ts');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function lineCount(rel) {
  return read(rel).split(/\r?\n/).length;
}

async function main() {
  const oldWriterModel = process.env.BLOG_WRITER_MODEL;
  const oldMarketing = process.env.BLOG_MARKETING_ENABLED;
  const oldSns = process.env.BLOG_SNS_CROSSPOST_ENABLED;
  const oldTelemetryPath = process.env.BLOG_TELEMETRY_PATH;

  try {
    delete process.env.BLOG_WRITER_MODEL;
    assert.equal(resolveBlogWriterModel(), DEFAULT_BLOG_WRITER_MODEL, 'writer model default must be haiku');
    process.env.BLOG_WRITER_MODEL = 'anthropic_sonnet';
    assert.equal(resolveBlogWriterModel(), 'anthropic_sonnet', 'writer model env override missing');
    assert.equal(writerModelCacheSuffix('claude code/sonnet'), 'claude_code_sonnet');

    const gems = read('lib/gems-writer.ts');
    const pos = read('lib/pos-writer.ts');
    const chunked = fs.readFileSync(path.join(ROOT, '../../packages/core/lib/chunked-llm.ts'), 'utf8');
    const blo = read('lib/blo.ts');
    assert.ok(gems.includes('abstractModel: writerModel'), 'gems direct writer must pass abstractModel');
    assert.ok(pos.includes('abstractModel: writerModel'), 'pos direct writer must pass abstractModel');
    assert.ok(chunked.includes('abstractModel') && chunked.includes('callHubLlm'), 'chunkedGenerate must pass abstractModel');
    assert.ok(gems.includes('writerModelCacheSuffix') && pos.includes('writerModelCacheSuffix'), 'writer cache must be model scoped');
    assert.ok(blo.includes('buildWriterAbMetadata(post, traceCtx)'), 'post metadata writer model helper missing');
    assert.ok(blo.includes('metadata.served_model = servedModel'), 'post metadata served_model tag missing');
    assert.ok(blo.includes('metadata.fallback_used = Boolean'), 'post metadata fallback_used tag missing');
    assert.ok(blo.includes('metadata.trace_id = traceId'), 'post metadata trace_id tag missing');

    const comparison = buildWriterModelCrankComparison([
      { writer_model: 'anthropic_haiku', overall: 62, post_type: 'general' },
      { writer_model: 'anthropic_haiku', overall: 66, post_type: 'lecture' },
      { writer_model: 'anthropic_sonnet', overall: 70, post_type: 'general' },
    ], { minSamples: 5 });
    assert.equal(comparison.totalSamples, 3);
    assert.ok(comparison.models.every((item) => item.verdict === '판정 불가'), 'sample guard must block under 5 samples');

    delete process.env.BLOG_MARKETING_ENABLED;
    assert.equal(isBlogMarketingEnabled(), false, 'marketing must default off');
    assert.equal(buildMarketingDisabledResult('smoke').reason, 'blog_marketing_disabled');

    delete process.env.BLOG_SNS_CROSSPOST_ENABLED;
    assert.equal(isSnsCrosspostEnabled(), false, 'SNS crosspost must default off');
    assert.equal(buildSnsCrosspostDisabledResult('instagram').reason, 'blog_sns_crosspost_disabled');
    process.env.BLOG_SNS_CROSSPOST_ENABLED = 'true';
    assert.equal(isSnsCrosspostEnabled(), true, 'SNS gate true branch missing');

    const telemetryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-telemetry-'));
    const telemetryPath = path.join(telemetryDir, 'telemetry.jsonl');
    process.env.BLOG_TELEMETRY_PATH = telemetryPath;
    const written = recordBlogTelemetry({ stage: 'collection', event: 'start', smoke: true });
    assert.equal(written.ok, true, 'telemetry append failed');
    const tail = tailBlogTelemetry(5, telemetryPath);
    assert.equal(tail.length, 1);
    assert.equal(tail[0].stage, 'collection');

    assert.ok(lineCount('skills/blog-writing/SKILL.md') <= 41, 'blog-writing SKILL.md line budget exceeded');
    for (const name of ['concrete-writing', 'diagnosis-reading', 'comment-strategy', 'external-sources', 'gotchas']) {
      assert.ok(lineCount(`skills/blog-writing/commands/${name}.md`) <= 120, `${name} command doc line budget exceeded`);
    }

    const card = JSON.parse(read('a2a/blog-card.json'));
    const skillIds = new Set(card.skills.map((skill) => skill.id));
    assert.ok(skillIds.has('great-library-w-axis'), 'A2A Great Library skill missing');
    assert.ok(skillIds.has('sigma-success-pattern'), 'A2A Sigma success pattern skill missing');
    assert.ok(skillIds.has('comment-evolution-proposal'), 'A2A comment evolution skill missing');

    const ops = await import('../a2a/skills/blog-remodel-ops.ts');
    const taskHandler = await import('../a2a/handlers/task-handler.ts');
    ops.registerBlogRemodelOpsSkills();
    const sigmaResult = await taskHandler.handleTask({
      id: 'smoke-sigma-pattern',
      skill: { id: 'sigma-success-pattern' },
      params: { query: 'blog success_pattern', limit: 1 },
    });
    assert.equal(sigmaResult.status, 'completed');
    assert.ok(sigmaResult.output?.ok === true || sigmaResult.output?.skipped === true, 'sigma lookup must succeed or structured-skip');

    console.log(JSON.stringify({
      ok: true,
      writerModelDefault: DEFAULT_BLOG_WRITER_MODEL,
      writerModelComparison: comparison,
      telemetryEvents: tail.length,
      a2aSkills: [...skillIds].filter((id) => ['great-library-w-axis', 'sigma-success-pattern', 'comment-evolution-proposal'].includes(id)),
      sigmaLookup: sigmaResult.output,
    }, null, 2));
  } finally {
    if (oldWriterModel == null) delete process.env.BLOG_WRITER_MODEL;
    else process.env.BLOG_WRITER_MODEL = oldWriterModel;
    if (oldMarketing == null) delete process.env.BLOG_MARKETING_ENABLED;
    else process.env.BLOG_MARKETING_ENABLED = oldMarketing;
    if (oldSns == null) delete process.env.BLOG_SNS_CROSSPOST_ENABLED;
    else process.env.BLOG_SNS_CROSSPOST_ENABLED = oldSns;
    if (oldTelemetryPath == null) delete process.env.BLOG_TELEMETRY_PATH;
    else process.env.BLOG_TELEMETRY_PATH = oldTelemetryPath;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
