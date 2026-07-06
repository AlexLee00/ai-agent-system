#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lifecycle = require('../packages/core/lib/agent-lifecycle.ts');

function response(json) {
  return {
    ok: true,
    status: 200,
    json: async () => json,
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lifecycle-smoke-'));
const personaFile = path.join(tmp, 'AGENTS.md');
fs.writeFileSync(personaFile, [
  '# AGENTS.md — 스모크팀 에이전트',
  '',
  '> 스모크의 정신: "작게 검증하고 크게 망치지 않는다."',
  '',
  '## 원칙 1: 경계를 지킨다',
  'DB write, launchctl, commit은 하지 않는다.',
  '',
  '## 원칙 2: 기억은 출처와 함께 쓴다',
  '출처 없는 기억은 주입하지 않는다.',
].join('\n'), 'utf8');

const persona = lifecycle.loadPersona('smoke_lifecycle', { filePath: personaFile, maxChars: 600 });
assert.ok(persona.length > 0, 'persona summary should exist');
assert.ok(persona.length <= 600, 'persona summary should be capped');
assert.equal(lifecycle.clampLimit(15), 10, 'limit should clamp to 10');

const rows = [
  {
    id: 1,
    title: 'validated blog memory',
    contentPreview: 'validated memory',
    similarity: 0.7,
    source: 'blog',
    meta: { team: 'blog', libraryCoords: { validation_state: 'validated' } },
    libraryCoords: { validation_state: 'validated' },
  },
  {
    id: 2,
    title: 'other team memory',
    contentPreview: 'must not leak',
    similarity: 0.99,
    source: 'investment',
    meta: { team: 'investment', libraryCoords: { validation_state: 'validated' } },
    libraryCoords: { validation_state: 'validated' },
  },
  {
    id: 3,
    title: 'unverified blog memory',
    contentPreview: 'later memory',
    similarity: 0.9,
    source: 'blog',
    meta: { team: 'blog', libraryCoords: { validation_state: 'unverified' } },
    libraryCoords: { validation_state: 'unverified' },
  },
];

const fetchOk = async (_url, opts) => {
  const body = JSON.parse(opts.body);
  assert.equal(body.method, 'tools/call');
  assert.equal(body.params.name, 'library-search');
  assert.equal(body.params.arguments.limit, 10);
  return response({
    jsonrpc: '2.0',
    id: body.id,
    result: { content: [{ type: 'json', json: { ok: true, results: rows } }] },
  });
};

(async () => {
  const recall = await lifecycle.recallMemories({
    team: 'blog',
    agent: 'gems',
    topic: 'validated writing pattern',
    limit: 15,
    fetch: fetchOk,
  });
  assert.equal(recall.effectiveLimit, 10);
  assert.deepEqual(recall.memories.map((item) => item.id), [1, 3], 'must filter to team namespace and keep validated first');
  assert.ok(recall.memories.every((item) => item.sourceTag.startsWith('vault-entry:')));

  const skipped = await lifecycle.recallMemories({
    team: 'blog',
    agent: 'gems',
    topic: 'network skip',
    fetch: async () => { throw new Error('offline'); },
  });
  assert.equal(skipped.skipped, true);
  assert.deepEqual(skipped.memories, []);

  const block = lifecycle.buildLifecycleBlock({ persona, memories: recall.memories });
  assert.ok(block.includes(lifecycle.LIFECYCLE_BEGIN));
  assert.ok(block.includes('[BOOT]'));
  assert.ok(block.includes('[RECALL]'));

  const telemetryPath = path.join(tmp, 'telemetry.jsonl');
  const telemetry = lifecycle.recordLifecycleTelemetry({
    team: 'blog',
    agent: 'gems',
    event: 'smoke',
  }, { env: { AGENT_LIFECYCLE_TELEMETRY_PATH: telemetryPath } });
  assert.equal(telemetry.ok, true);
  assert.ok(fs.readFileSync(telemetryPath, 'utf8').includes('"agent":"gems"'));

  const contextOff = await lifecycle.buildLifecyclePromptContext({
    team: 'blog',
    agent: 'gems',
    topic: 'off mode',
    enabled: false,
    env: { AGENT_LIFECYCLE_TELEMETRY_PATH: telemetryPath },
    personaFn: () => persona,
    recallFn: async () => ({ ok: true, memories: recall.memories }),
  });
  assert.equal(contextOff.promptBlock, '', 'off mode must not inject');
  assert.ok(contextOff.block.includes(lifecycle.LIFECYCLE_BEGIN), 'off mode still builds shadow block');

  const contextOn = await lifecycle.buildLifecyclePromptContext({
    team: 'blog',
    agent: 'gems',
    topic: 'on mode',
    enabled: true,
    env: { AGENT_LIFECYCLE_TELEMETRY_PATH: telemetryPath },
    personaFn: () => persona,
    recallFn: async () => ({ ok: true, memories: recall.memories }),
  });
  assert.ok(contextOn.promptBlock.includes(lifecycle.LIFECYCLE_BEGIN), 'on mode must inject block');

  const payload = {
    ok: true,
    smoke: 'agent-lifecycle',
    personaChars: persona.length,
    memoryIds: recall.memories.map((item) => item.id),
    telemetryPath,
  };
  console.log(JSON.stringify(payload, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
