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
  {
    id: 4,
    title: 'spoofed top-level team',
    contentPreview: 'canonical provenance must win',
    similarity: 1,
    source: 'blog',
    meta: {
      team: 'blog',
      source_ref: { team: 'investment', table: 'investment.trade_journal', id: '4' },
      libraryCoords: { validation_state: 'validated' },
    },
    libraryCoords: { validation_state: 'validated' },
  },
];

const fetchOk = async (_url, opts) => {
  const body = JSON.parse(opts.body);
  assert.equal(body.method, 'tools/call');
  assert.equal(body.params.name, 'library-search');
  assert.equal(body.params.arguments.limit, 10);
  assert.deepEqual(body.params.arguments.teamNamespaces, ['blog', 'blo']);
  assert.equal(body.params.arguments.intent, 'strategy');
  assert.deepEqual(body.params.arguments.coordFilters, { validation_state: ['validated'] });
  assert.equal(body.params.arguments.strictLayerFilters, true);
  assert.equal(body.params.arguments.groupBySourceRef, true);
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
  assert.deepEqual(recall.memories.map((item) => item.id), [1], 'must inject only validated memories from the team namespace');
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
  const telemetryBeforeOff = fs.readFileSync(telemetryPath, 'utf8');

  const contextOff = await lifecycle.buildLifecyclePromptContext({
    team: 'blog',
    agent: 'gems',
    topic: 'off mode',
    enabled: false,
    env: { AGENT_LIFECYCLE_TELEMETRY_PATH: telemetryPath },
    personaFn: () => { throw new Error('persona should not load when disabled'); },
    recallFn: async () => { throw new Error('recall should not run when disabled'); },
  });
  assert.equal(contextOff.promptBlock, '', 'off mode must not inject');
  assert.equal(contextOff.block, '', 'off mode must not build shadow block');
  assert.equal(contextOff.recall.skipped, true, 'off mode must report skipped recall');
  assert.equal(fs.readFileSync(telemetryPath, 'utf8'), telemetryBeforeOff, 'off mode must not append telemetry');

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
