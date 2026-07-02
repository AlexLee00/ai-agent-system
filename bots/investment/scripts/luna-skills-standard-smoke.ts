#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { loadInvestmentSkills } from '../shared/skill-registry.ts';

const dir = new URL('../skills/luna/', import.meta.url).pathname;
const files = readdirSync(dir).filter((file) => file.endsWith('.skill.md')).sort();
assert.equal(files.length, 11);

for (const file of files) {
  const text = readFileSync(join(dir, file), 'utf8');
  assert.ok(text.startsWith('---\n'), `${file} missing frontmatter`);
  const end = text.indexOf('\n---\n', 4);
  assert.ok(end > 0, `${file} malformed frontmatter`);
  const meta = yaml.load(text.slice(4, end)) || {};
  assert.ok(meta.name, `${file} missing name`);
  assert.ok(meta.description, `${file} missing description`);
  assert.ok(Array.isArray(meta.triggers) && meta.triggers.length > 0, `${file} missing triggers`);
}

const loaded = loadInvestmentSkills();
assert.ok(Array.isArray(loaded) && loaded.length >= 11);
assert.ok(loaded.some((skill) => String(skill.metadata?.path || '').endsWith('glossary.skill.md')));
assert.ok(loaded.some((skill) => String(skill.metadata?.path || '').endsWith('trend-following.skill.md')));

const payload = { ok: true, smoke: 'luna-skills-standard', skillCount: files.length };
if (process.argv.includes('--json')) console.log(JSON.stringify(payload, null, 2));
else console.log('luna-skills-standard-smoke ok');
