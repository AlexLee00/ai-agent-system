#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';

const sqlPath = new URL('./sql/event-lake-duplicate-index-cleanup-draft.sql', import.meta.url);
const sql = fs.readFileSync(sqlPath, 'utf8');
const activeSql = sql.split('\n')
  .filter((line) => line.trim() && !line.trim().startsWith('--'))
  .join('\n');
const candidates = [
  'event_lake_new_severity_created_at_idx',
  'event_lake_new_tags_idx',
  'event_lake_new_team_created_at_idx',
  'event_lake_new_created_at_idx',
  'event_lake_new_event_type_created_at_idx',
  'event_lake_new_expr_idx',
];
const recreateDefinitions = [
  "CREATE INDEX CONCURRENTLY event_lake_new_expr_idx ON agent.event_lake USING btree (((metadata ->> 'cycle_id'::text)));",
  'CREATE INDEX CONCURRENTLY event_lake_new_event_type_created_at_idx ON agent.event_lake USING btree (event_type, created_at DESC);',
  'CREATE INDEX CONCURRENTLY event_lake_new_created_at_idx ON agent.event_lake USING btree (created_at DESC);',
  'CREATE INDEX CONCURRENTLY event_lake_new_team_created_at_idx ON agent.event_lake USING btree (team, created_at DESC);',
  'CREATE INDEX CONCURRENTLY event_lake_new_tags_idx ON agent.event_lake USING gin (tags);',
  'CREATE INDEX CONCURRENTLY event_lake_new_severity_created_at_idx ON agent.event_lake USING btree (severity, created_at DESC);',
];

assert.equal(activeSql, '', 'draft DDL must remain fully commented');
assert.doesNotMatch(activeSql, /\b(?:BEGIN|COMMIT|ROLLBACK)\b/i, 'CONCURRENTLY must stay outside transactions');
assert.doesNotMatch(sql, /^\s*--\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;?\s*$/im, 'draft must not hide transaction controls in comments');
assert.doesNotMatch(sql, /event_lake_new_pkey/i, 'primary-key backing index must never be in cleanup draft');
assert.equal((sql.match(/DROP INDEX CONCURRENTLY/gi) || []).length, 6);
assert.equal((sql.match(/CREATE INDEX CONCURRENTLY/gi) || []).length, 6);
for (const candidate of candidates) {
  assert.match(sql, new RegExp(`DROP INDEX CONCURRENTLY IF EXISTS agent\\.${candidate}`));
  assert.match(sql, new RegExp(`CREATE INDEX CONCURRENTLY ${candidate}`));
}
for (const definition of recreateDefinitions) assert.ok(sql.includes(definition));
assert.match(sql, /lock_timeout/i);
assert.match(sql, /statement_timeout/i);
assert.match(sql, /one statement at a time/i);

console.log(JSON.stringify({
  ok: true,
  smoke: 'event-lake-duplicate-index-cleanup-draft',
  candidates: candidates.length,
  liveDdlExecuted: false,
}));
