#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  INVESTMENT_SCHEMA_TABLE_FAMILIES,
  runInvestmentSchemaTableFamilies,
} from '../shared/db/schema/tables/index.ts';

const familyNames = INVESTMENT_SCHEMA_TABLE_FAMILIES.map((family) => family.name);
assert.deepEqual(familyNames, ['bootstrap']);

const statements = [];
const executedFamilies = await runInvestmentSchemaTableFamilies(async (sql, params = []) => {
  statements.push({ sql: String(sql || ''), params });
}, { log: false });

assert.deepEqual(executedFamilies, ['bootstrap']);
assert.equal(statements.some((entry) => /CREATE TABLE IF NOT EXISTS schema_migrations/i.test(entry.sql)), true);
assert.equal(statements.some((entry) => /CREATE TABLE IF NOT EXISTS signals/i.test(entry.sql)), true);
assert.equal(statements.some((entry) => /CREATE TABLE IF NOT EXISTS luna_posttrade_skills/i.test(entry.sql)), true);

const payload = {
  ok: true,
  smoke: 'db-schema-table-registry',
  familyNames,
  statementCount: statements.length,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('db-schema-table-registry-smoke ok');
}
