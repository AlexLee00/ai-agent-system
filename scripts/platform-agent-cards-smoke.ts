#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const CARD_CONTRACTS = [
  {
    id: 'hub',
    file: 'bots/hub/a2a/hub-card.json',
    requiredTags: ['hub', 'kernel', 'registry', 'llm'],
    requiredSkillIds: ['hub-health', 'llm-routing', 'agent-registry', 'alarm-governance', 'ops-mcp'],
  },
  {
    id: 'orchestrator',
    file: 'bots/orchestrator/a2a/orchestrator-card.json',
    requiredTags: ['orchestrator', 'control-plane', 'hub-convergence', 'shadow'],
    requiredSkillIds: ['commander-dispatch', 'team-coordination', 'ops-health-briefing', 'registry-dual-read-shadow', 'llm-policy-shadow'],
  },
];

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8'));
}

function validateCard(contract) {
  const card = readJson(contract.file);
  assert.equal(typeof card.name, 'string', `${contract.file} name`);
  assert.equal(card.version, '1.0.0', `${contract.file} version`);
  assert.match(String(card.url || ''), /^(https?:\/\/|local:\/\/)/, `${contract.file} url`);
  assert(Array.isArray(card.defaultInputModes), `${contract.file} defaultInputModes`);
  assert(Array.isArray(card.defaultOutputModes), `${contract.file} defaultOutputModes`);
  assert(card.capabilities && typeof card.capabilities === 'object', `${contract.file} capabilities`);
  assert(Array.isArray(card.skills) && card.skills.length >= contract.requiredSkillIds.length, `${contract.file} skills`);

  const ids = new Set(card.skills.map((skill) => skill.id));
  for (const skillId of contract.requiredSkillIds) assert(ids.has(skillId), `${contract.file} missing skill ${skillId}`);

  const tagText = card.skills.flatMap((skill) => skill.tags || []).join(' ');
  for (const tag of contract.requiredTags) assert(tagText.includes(tag), `${contract.file} missing tag ${tag}`);

  for (const skill of card.skills) {
    assert.equal(typeof skill.id, 'string', `${contract.file} skill.id`);
    assert.equal(typeof skill.name, 'string', `${contract.file} skill.name`);
    assert.equal(typeof skill.description, 'string', `${contract.file} skill.description`);
    assert(Array.isArray(skill.tags) && skill.tags.length > 0, `${contract.file} skill.tags`);
    assert(Array.isArray(skill.inputModes) && skill.inputModes.includes('application/json'), `${contract.file} skill.inputModes`);
    assert(Array.isArray(skill.outputModes) && skill.outputModes.includes('application/json'), `${contract.file} skill.outputModes`);
  }

  return {
    id: contract.id,
    file: contract.file,
    skills: card.skills.length,
    capabilities: Object.keys(card.capabilities).sort(),
  };
}

export function runPlatformAgentCardsSmoke() {
  const cards = CARD_CONTRACTS.map(validateCard);
  return {
    ok: true,
    suite: 'platform-agent-cards-smoke',
    cards,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = runPlatformAgentCardsSmoke();
    if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else console.log('platform-agent-cards-smoke ok');
  } catch (error) {
    console.error(`platform-agent-cards-smoke failed: ${error?.stack || error?.message || error}`);
    process.exitCode = 1;
  }
}
