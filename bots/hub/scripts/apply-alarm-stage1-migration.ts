#!/usr/bin/env tsx
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
process.env.PG_DIRECT ||= 'true';
const pgPool = require('../../../packages/core/lib/pg-pool');

const CONFIRM = 'alarm-stage1-migration';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(__dirname, '../migrations/20261001000050_hub_alarm_tables.sql');
const requiredTables = ['hub_alarm_classifications', 'hub_alarms', 'alarm_roundtables'];

function hasArg(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function argValue(name: string, fallback = ''): string {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || fallback;
}

function splitStatements(sql: string): string[] {
  return String(sql || '')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export async function inspectAlarmStage1Tables() {
  const rows = await pgPool.query('agent', `
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'agent'
       AND table_name = ANY($1::text[])
     ORDER BY table_name
  `, [requiredTables]).catch(() => []);
  const present = new Set((rows || []).map((row: any) => String(row.table_name)));
  return {
    required: requiredTables,
    present: requiredTables.filter((table) => present.has(table)),
    missing: requiredTables.filter((table) => !present.has(table)),
  };
}

export async function applyAlarmStage1Migration({
  apply = hasArg('apply'),
  confirm = argValue('confirm'),
} = {}) {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  const statements = splitStatements(sql);
  const before = await inspectAlarmStage1Tables();

  if (!apply) {
    return {
      ok: true,
      status: 'dry_run',
      migrationPath,
      statements: statements.length,
      before,
      requiredConfirm: CONFIRM,
    };
  }
  if (confirm !== CONFIRM) {
    return {
      ok: false,
      status: 'confirm_required',
      migrationPath,
      statements: statements.length,
      before,
      requiredConfirm: CONFIRM,
    };
  }

  await pgPool.run('agent', 'CREATE SCHEMA IF NOT EXISTS agent');
  for (const statement of statements) {
    await pgPool.run('agent', statement);
  }
  const after = await inspectAlarmStage1Tables();
  return {
    ok: after.missing.length === 0,
    status: after.missing.length === 0 ? 'applied' : 'missing_tables_after_apply',
    migrationPath,
    statements: statements.length,
    before,
    after,
  };
}

async function main() {
  const result = await applyAlarmStage1Migration();
  if (hasArg('json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`[alarm-stage1-migration] ${result.status} missing=${(result as any).after?.missing?.length ?? result.before?.missing?.length ?? 0}`);
  if (!result.ok) process.exit(1);
}

main()
  .catch((error) => {
    console.error('[alarm-stage1-migration] failed:', error?.message || error);
    process.exit(1);
  })
  .finally(() => {
    pgPool.closeAll?.().catch?.(() => {});
  });
