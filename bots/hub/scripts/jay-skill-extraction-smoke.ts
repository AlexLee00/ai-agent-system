#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const skills = require('../../orchestrator/lib/jay-skill-extractor.ts');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jay-skill-artifacts-'));
  const originalWrite = process.env.JAY_SKILL_ARTIFACT_WRITE;
  const originalRoot = process.env.JAY_SKILL_ARTIFACT_ROOT;
  process.env.JAY_SKILL_ARTIFACT_WRITE = 'true';
  process.env.JAY_SKILL_ARTIFACT_ROOT = tempRoot;

  try {
  await skills.ensureJaySkillMemoryTable();

  const incidentKey = `skill-extract-smoke:${Date.now()}`;
  const saved = await skills.saveSkillMemory({
    incidentKey,
    team: 'luna',
    strategyKey: 'luna:reconcile_guard',
    summary: '체결 후 pending reconcile 먼저 확인하고 포지션 반영',
    evidence: { source: 'smoke' },
    outcomeStatus: 'completed',
    confidence: 0.8,
  });
  assert.equal(saved?.ok, true, 'skill save should succeed');
  assert.ok(saved?.artifactPath, 'skill artifact path should be returned');
  assert.equal(fs.existsSync(saved.artifactPath), true, 'SKILL.md artifact should be written when enabled');

  const rows = await skills.listRecentSkills({
    team: 'luna',
    strategyKey: 'luna:reconcile_guard',
    limit: 5,
    days: 30,
  });
  assert.ok(Array.isArray(rows));
  assert.ok(rows.some((row) => row.incident_key === incidentKey), 'saved skill should be queryable');
  console.log('jay_skill_extraction_smoke_ok');
  } finally {
    if (originalWrite == null) delete process.env.JAY_SKILL_ARTIFACT_WRITE;
    else process.env.JAY_SKILL_ARTIFACT_WRITE = originalWrite;
    if (originalRoot == null) delete process.env.JAY_SKILL_ARTIFACT_ROOT;
    else process.env.JAY_SKILL_ARTIFACT_ROOT = originalRoot;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`jay_skill_extraction_smoke_failed: ${error?.message || error}`);
  process.exit(1);
});
