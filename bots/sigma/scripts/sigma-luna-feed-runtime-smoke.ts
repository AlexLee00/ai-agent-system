#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runSigmaLunaFeed } from './runtime-sigma-luna-feed.ts';

const source = fs.readFileSync(fileURLToPath(new URL('./runtime-sigma-luna-feed.ts', import.meta.url)), 'utf8');
const migration = fs.readFileSync(fileURLToPath(new URL('../migrations/20260722000001_sigma_entity_facts.sql', import.meta.url)), 'utf8');
assert.doesNotMatch(source, /CREATE TABLE|ALTER TABLE|CREATE INDEX|UPDATE sigma\.entity_facts/i);
assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS entity_facts_team_agent_name_entity_entity_type_key/i);

const calls = [];
const result = await runSigmaLunaFeed({
  limit: 5,
  dryRun: true,
  write: false,
  deps: {
    queryReadonly: async (schema, sql) => {
      calls.push({ kind: 'read', schema, sql });
      return [];
    },
    run: async (...args) => {
      calls.push({ kind: 'write', args });
      throw new Error('dry_run_must_not_write');
    },
  },
});

assert.equal(result.dryRun, true);
assert.equal(calls.filter((call) => call.kind === 'write').length, 0);
assert.equal(calls.every((call) => call.kind !== 'read' || /^\s*SELECT/i.test(call.sql)), true);

console.log(JSON.stringify({ ok: true, smoke: 'sigma-luna-feed-runtime', writes: 0 }, null, 2));
