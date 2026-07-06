#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lifecycle = require('../../../packages/core/lib/agent-lifecycle.ts');
const env = require('../../../packages/core/lib/env');

const gemsSource = fs.readFileSync(path.join(env.PROJECT_ROOT, 'bots/blog/lib/gems-writer.ts'), 'utf8');
const posSource = fs.readFileSync(path.join(env.PROJECT_ROOT, 'bots/blog/lib/pos-writer.ts'), 'utf8');

assert.ok(gemsSource.includes('buildLifecyclePromptContext'), 'gems writer must build lifecycle context');
assert.ok(posSource.includes('buildLifecyclePromptContext'), 'pos writer must build lifecycle context');
assert.ok(gemsSource.includes('BLOG_LIFECYCLE_INJECT_ENABLED'), 'gems writer must keep env gate');
assert.ok(posSource.includes('BLOG_LIFECYCLE_INJECT_ENABLED'), 'pos writer must keep env gate');
assert.ok(gemsSource.includes('writingLearningsBlock') && gemsSource.includes('lifecyclePromptBlock'), 'gems lifecycle block must sit near learnings');
assert.ok(posSource.includes('writingLearningsBlock') && posSource.includes('lifecyclePromptBlock'), 'pos lifecycle block must sit near learnings');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-agent-lifecycle-smoke-'));
const telemetryPath = path.join(tmp, 'telemetry.jsonl');
const persona = '블로팀은 배우면서 쓰는 블로그 시스템이다.';
const memories = [
  { title: '검증된 제목 패턴', summary: '구체적 경험과 제목 다양성이 점수를 올렸다.', sourceTag: 'vault-entry:blog-1' },
];

(async () => {
  const off = await lifecycle.buildLifecyclePromptContext({
    team: 'blog',
    agent: 'gems',
    topic: 'IT 글 제목 다양성',
    enabled: false,
    env: { AGENT_LIFECYCLE_TELEMETRY_PATH: telemetryPath },
    personaFn: () => persona,
    recallFn: async () => ({ ok: true, memories }),
  });
  assert.equal(off.promptBlock, '', 'BLOG_LIFECYCLE_INJECT_ENABLED=false must not inject');
  assert.ok(off.block.includes(lifecycle.LIFECYCLE_BEGIN), 'shadow block should still be built');

  const on = await lifecycle.buildLifecyclePromptContext({
    team: 'blog',
    agent: 'pos',
    topic: '강의 글 구조',
    enabled: true,
    env: { AGENT_LIFECYCLE_TELEMETRY_PATH: telemetryPath },
    personaFn: () => persona,
    recallFn: async () => ({ ok: true, memories }),
  });
  assert.equal((on.promptBlock.match(/AGENT_LIFECYCLE:BEGIN/g) || []).length, 1, 'enabled mode must inject exactly one block');
  assert.ok(fs.readFileSync(telemetryPath, 'utf8').includes('"team":"blog"'), 'telemetry should append');

  console.log(JSON.stringify({
    ok: true,
    smoke: 'blog-agent-lifecycle',
    hookFiles: ['gems-writer.ts', 'pos-writer.ts'],
    offInjected: Boolean(off.promptBlock),
    onMarkerCount: (on.promptBlock.match(/AGENT_LIFECYCLE:BEGIN/g) || []).length,
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
