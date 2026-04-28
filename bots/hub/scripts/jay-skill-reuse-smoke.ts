#!/usr/bin/env tsx
import assert from 'node:assert/strict';

async function main() {
  const skills = require('../../orchestrator/lib/jay-skill-extractor.ts');
  await skills.ensureJaySkillMemoryTable();

  const incidentKey = `skill-reuse-smoke:${Date.now()}`;
  await skills.saveSkillMemory({
    incidentKey,
    team: 'blog',
    strategyKey: 'blog:queue_first_publish',
    summary: 'publish 전에 queue row 삽입 여부를 먼저 확인',
    evidence: { source: 'smoke' },
    outcomeStatus: 'completed',
    confidence: 0.77,
  });

  const context = await skills.buildSkillContextForPlan({
    team: 'blog',
    strategyKey: 'blog:queue_first_publish',
    limit: 3,
    days: 60,
  });
  assert.equal(context?.ok, true, 'skill context build should succeed');
  assert.ok(String(context?.context || '').includes('Recent reusable skills:'), 'context header missing');
  assert.ok(String(context?.context || '').includes('queue row'), 'skill summary not injected');
  console.log('jay_skill_reuse_smoke_ok');
}

main().catch((error) => {
  console.error(`jay_skill_reuse_smoke_failed: ${error?.message || error}`);
  process.exit(1);
});
