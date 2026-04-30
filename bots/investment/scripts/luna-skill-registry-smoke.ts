#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { createInvestmentSkillRegistry, loadInvestmentSkills } from '../shared/skill-registry.ts';

export async function runSkillRegistrySmoke() {
  const skills = loadInvestmentSkills();
  const registry = createInvestmentSkillRegistry();
  assert.ok(skills.length >= 30, `expected >=30 skills, got ${skills.length}`);
  for (const owner of ['aria', 'luna', 'reporter', 'argos', 'sweeper', 'sentinel', 'nemesis', 'chronos', 'stock-flow', 'hephaestos', 'kairos']) {
    assert.ok(registry.list({ owner }).length >= 1, `owner has skills: ${owner}`);
  }
  const execution = await registry.execute('backtest-runner', { smoke: true }, { dryRun: true });
  assert.equal(execution.ok, true);
  assert.equal(execution.code, 'skill_noop');
  return {
    ok: true,
    skillCount: skills.length,
    owners: Array.from(new Set(skills.map((skill) => skill.owner))).sort(),
    sampleExecution: execution.code,
  };
}

async function main() {
  const result = await runSkillRegistrySmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`luna-skill-registry-smoke ok skills=${result.skillCount}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ luna-skill-registry-smoke 실패:' });
}
