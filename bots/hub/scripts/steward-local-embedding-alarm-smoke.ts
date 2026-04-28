#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const stewardPath = path.join(repoRoot, 'bots/orchestrator/src/steward.ts');
const source = fs.readFileSync(stewardPath, 'utf8');

assert.match(
  source,
  /checkLocalLLMHealth\(\{\s*embeddingsOnly:\s*true\s*\}\)/,
  'steward hourly health should only check local embedding infrastructure',
);
assert.match(
  source,
  /eventType:\s*'local_embedding_health_degraded'/,
  'local embedding failures must have an infrastructure-specific event type',
);
assert.match(
  source,
  /steward_llm_route:\s*'gemini-cli-oauth'/,
  'alarm payload must make clear that steward LLM routing is Gemini OAuth, not local LLM',
);
assert.match(
  source,
  /visibility:\s*'internal'/,
  'local embedding health failures should stay internal for agent repair routing',
);
assert.match(
  source,
  /actionability:\s*'auto_repair'/,
  'local embedding health failures should route into auto-repair before human noise',
);

console.log(JSON.stringify({
  ok: true,
  steward_llm_route_documented: true,
  local_embedding_alarm_internal: true,
}));
