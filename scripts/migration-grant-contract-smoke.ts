#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  analyzeMigrationGrantContract,
  HUB_READONLY_GRANT_POLICY,
} from '../packages/core/lib/migration-grant-contract.ts';
import {
  renderGrantRemediationDraft,
  runReadOnlyPrivilegeAudit,
} from './db/read-only-privilege-audit.ts';
import { migrationSqlSource } from './migration-grant-gate.ts';

const missingGrant = analyzeMigrationGrantContract(`
  CREATE TABLE IF NOT EXISTS investment.fixture_missing_grant (id bigint PRIMARY KEY);
`);
assert.deepEqual(
  missingGrant.violations.map((row) => row.code),
  ['schema_usage_grant_missing', 'table_select_grant_missing'],
);

const complete = analyzeMigrationGrantContract(`
  CREATE TABLE IF NOT EXISTS investment.fixture_complete (id bigint PRIMARY KEY);
  GRANT USAGE ON SCHEMA investment TO hub_readonly;
  GRANT SELECT ON TABLE investment.fixture_complete TO hub_readonly;
`);
assert.equal(complete.createdTables.length, 1);
assert.deepEqual(complete.violations, []);

const boundaryOnly = analyzeMigrationGrantContract(`
  ALTER TABLE investment.existing_table ADD COLUMN IF NOT EXISTS note text;
  CREATE VIEW investment.fixture_view AS SELECT 1 AS value;
  COMMENT ON TABLE investment.existing_table IS 'CREATE TABLE public.not_real (id int)';
  -- CREATE TABLE investment.commented_out (id bigint);
  -- GRANT SELECT ON TABLE investment.commented_out TO hub_readonly;
`);
assert.equal(boundaryOnly.createdTables.length, 0);
assert.deepEqual(boundaryOnly.violations, []);

const partial = analyzeMigrationGrantContract(`
  CREATE UNLOGGED TABLE hub.first_table (id bigint);
  CREATE TABLE hub.second_table AS SELECT 1 AS id;
  GRANT USAGE ON SCHEMA hub TO hub_readonly;
  GRANT SELECT ON TABLE hub.first_table TO hub_readonly;
`);
assert.deepEqual(partial.violations.map((row) => row.code), ['table_select_grant_missing']);
assert.equal(partial.violations[0]?.relation, 'hub.second_table');

const quoted = analyzeMigrationGrantContract(`
  CREATE TABLE "hub"."QuotedTable" (id bigint);
  GRANT USAGE ON SCHEMA "hub" TO "hub_readonly";
  GRANT SELECT ON TABLE "hub"."QuotedTable" TO "hub_readonly";
`);
assert.deepEqual(quoted.violations, []);

const quotedPunctuation = analyzeMigrationGrantContract(`
  CREATE TABLE "hub"."Semi;Colon" (id bigint);
  CREATE TABLE "hub"."Comma,Table" (id bigint);
  GRANT USAGE ON SCHEMA "hub" TO "hub_readonly";
  GRANT SELECT ON TABLE "hub"."Semi;Colon", "hub"."Comma,Table" TO "hub_readonly";
`);
assert.deepEqual(quotedPunctuation.violations, []);

const revoked = analyzeMigrationGrantContract(`
  CREATE TABLE hub.revoked_table (id bigint);
  GRANT USAGE ON SCHEMA hub TO hub_readonly;
  GRANT SELECT ON TABLE hub.revoked_table TO hub_readonly;
  REVOKE USAGE ON SCHEMA hub FROM hub_readonly;
  REVOKE SELECT ON TABLE hub.revoked_table FROM hub_readonly;
`);
assert.deepEqual(revoked.violations.map((row) => row.code), [
  'schema_usage_grant_missing',
  'table_select_grant_missing',
]);

const revokeAll = analyzeMigrationGrantContract(`
  CREATE TABLE hub.revoked_all_table (id bigint);
  GRANT USAGE ON SCHEMA hub TO hub_readonly;
  GRANT SELECT ON TABLE hub.revoked_all_table TO hub_readonly;
  REVOKE ALL ON TABLE hub.revoked_all_table FROM hub_readonly;
`);
assert.deepEqual(revokeAll.violations.map((row) => row.code), ['table_select_grant_missing']);

const revokeCascade = analyzeMigrationGrantContract(`
  CREATE TABLE hub.revoked_cascade_table (id bigint);
  GRANT USAGE ON SCHEMA hub TO hub_readonly;
  GRANT SELECT ON TABLE hub.revoked_cascade_table TO hub_readonly;
  REVOKE SELECT ON TABLE hub.revoked_cascade_table FROM hub_readonly CASCADE;
`);
assert.deepEqual(revokeCascade.violations.map((row) => row.code), ['table_select_grant_missing']);

const rolledBackGrants = analyzeMigrationGrantContract(`
  CREATE TABLE hub.rolled_back_grants (id bigint);
  BEGIN;
  GRANT USAGE ON SCHEMA hub TO hub_readonly;
  GRANT SELECT ON TABLE hub.rolled_back_grants TO hub_readonly;
  ROLLBACK;
`);
assert.deepEqual(rolledBackGrants.violations.map((row) => row.code), [
  'schema_usage_grant_missing',
  'table_select_grant_missing',
]);

const committedGrants = analyzeMigrationGrantContract(`
  BEGIN;
  CREATE TABLE hub.committed_grants (id bigint);
  GRANT USAGE ON SCHEMA hub TO hub_readonly;
  GRANT SELECT ON TABLE hub.committed_grants TO hub_readonly;
  COMMIT;
`);
assert.deepEqual(committedGrants.violations, []);

const chainedRollback = analyzeMigrationGrantContract(`
  BEGIN;
  GRANT USAGE ON SCHEMA hub TO hub_readonly;
  COMMIT AND CHAIN;
  CREATE TABLE hub.chained_rollback (id bigint);
  GRANT SELECT ON TABLE hub.chained_rollback TO hub_readonly;
  ROLLBACK;
`);
assert.deepEqual(chainedRollback.violations.map((row) => row.code), [
  'table_select_grant_missing',
]);

const unsafeAll = analyzeMigrationGrantContract(`
  CREATE TABLE hub.all_is_not_readonly (id bigint);
  GRANT USAGE ON SCHEMA hub TO hub_readonly;
  GRANT ALL ON TABLE hub.all_is_not_readonly TO hub_readonly;
`);
assert.deepEqual(unsafeAll.violations.map((row) => row.code), ['grant_privilege_scope_forbidden']);

const grantOption = analyzeMigrationGrantContract(`
  CREATE TABLE hub.grant_option_table (id bigint);
  GRANT USAGE ON SCHEMA hub TO hub_readonly;
  GRANT SELECT ON TABLE hub.grant_option_table TO hub_readonly WITH GRANT OPTION;
`);
assert.deepEqual(grantOption.violations.map((row) => row.code), ['grant_option_forbidden']);

const mixedRecipients = analyzeMigrationGrantContract(`
  CREATE TABLE hub.mixed_recipients (id bigint);
  GRANT USAGE ON SCHEMA hub TO hub_readonly;
  GRANT SELECT ON TABLE hub.mixed_recipients TO hub_readonly, PUBLIC;
`);
assert.deepEqual(mixedRecipients.violations.map((row) => row.code), ['grant_recipient_scope_forbidden']);

const unexpectedDmlGrant = analyzeMigrationGrantContract(`
  CREATE TABLE hub.overprivileged (id bigint);
  GRANT USAGE ON SCHEMA hub TO hub_readonly;
  GRANT SELECT ON TABLE hub.overprivileged TO hub_readonly;
  GRANT INSERT ON TABLE hub.overprivileged TO hub_readonly;
`);
assert.deepEqual(unexpectedDmlGrant.violations.map((row) => row.code), [
  'grant_privilege_scope_forbidden',
]);

const publicGrant = analyzeMigrationGrantContract(`
  CREATE TABLE hub.publicly_exposed (id bigint);
  GRANT USAGE ON SCHEMA hub TO hub_readonly;
  GRANT SELECT ON TABLE hub.publicly_exposed TO hub_readonly;
  GRANT SELECT ON TABLE hub.publicly_exposed TO PUBLIC;
`);
assert.deepEqual(publicGrant.violations.map((row) => row.code), ['public_grant_forbidden']);

const broadPublicGrant = analyzeMigrationGrantContract(`
  CREATE TABLE hub.broad_public (id bigint);
  GRANT USAGE ON SCHEMA hub TO hub_readonly;
  GRANT SELECT ON TABLE hub.broad_public TO hub_readonly;
  GRANT SELECT ON ALL TABLES IN SCHEMA hub TO PUBLIC;
`);
assert.deepEqual(broadPublicGrant.violations.map((row) => row.code), [
  'privilege_statement_unverifiable',
]);

const readonlyRoleMembership = analyzeMigrationGrantContract('GRANT app_writer TO hub_readonly;');
assert.deepEqual(readonlyRoleMembership.violations.map((row) => row.code), [
  'privilege_statement_unverifiable',
]);

const readonlyOwnership = analyzeMigrationGrantContract(`
  ALTER TABLE hub.existing OWNER TO hub_readonly;
`);
assert.deepEqual(readonlyOwnership.violations.map((row) => row.code), [
  'readonly_role_ownership_forbidden',
]);

const readonlyDefaultPrivilege = analyzeMigrationGrantContract(`
  ALTER DEFAULT PRIVILEGES IN SCHEMA hub GRANT INSERT ON TABLES TO hub_readonly;
`);
assert.deepEqual(readonlyDefaultPrivilege.violations.map((row) => row.code), [
  'default_privilege_change_requires_review',
]);

const inertCreateText = analyzeMigrationGrantContract(String.raw`
  SELECT E'prefix\'; CREATE TABLE investment.not_real (id int);';
  /* outer /* CREATE TABLE investment.still_not_real (id int); */ outer */
`);
assert.equal(inertCreateText.createdTables.length, 0);
assert.deepEqual(inertCreateText.violations, []);

const dynamicDdl = analyzeMigrationGrantContract(`
  DO $body$ BEGIN EXECUTE 'CREATE TABLE investment.dynamic_table (id int)'; END $body$;
`);
assert.deepEqual(dynamicDdl.violations.map((row) => row.code), ['dynamic_sql_unverifiable']);

const splitDynamicDdl = analyzeMigrationGrantContract(`
  DO $body$ BEGIN EXECUTE 'CREATE ' || 'TABLE investment.dynamic_table (id int)'; END $body$;
`);
assert.deepEqual(splitDynamicDdl.violations.map((row) => row.code), ['dynamic_sql_unverifiable']);

const singleQuotedDynamicDdl = analyzeMigrationGrantContract(`
  DO 'BEGIN EXECUTE ''CREATE TABLE investment.dynamic_table (id int)''; END';
`);
assert.deepEqual(singleQuotedDynamicDdl.violations.map((row) => row.code), [
  'dynamic_sql_unverifiable',
]);

const concatenatedDoBody = analyzeMigrationGrantContract(`
  DO 'BEGIN EXE'
  'CUTE ''CREATE TABLE investment.dynamic_table (id int)''; END';
`);
assert.deepEqual(concatenatedDoBody.violations.map((row) => row.code), [
  'dynamic_sql_unverifiable',
]);

const lexicalError = analyzeMigrationGrantContract('/* unterminated');
assert.deepEqual(lexicalError.violations.map((row) => row.code), ['sql_lexical_error']);

const temporary = analyzeMigrationGrantContract('CREATE TEMP TABLE scratch_table (id bigint);');
assert.equal(temporary.createdTables.length, 0);
assert.deepEqual(temporary.violations, []);

const unknownSchema = analyzeMigrationGrantContract(`
  CREATE TABLE legal.not_approved (id bigint);
  GRANT USAGE ON SCHEMA legal TO hub_readonly;
  GRANT SELECT ON TABLE legal.not_approved TO hub_readonly;
`);
assert.deepEqual(unknownSchema.violations.map((row) => row.code), ['schema_not_approved']);

const template = fs.readFileSync(new URL('./db/templates/create-table-migration.sql', import.meta.url), 'utf8')
  .replaceAll('__SCHEMA__', 'investment')
  .replaceAll('__TABLE__', 'fixture_from_template');
assert.deepEqual(analyzeMigrationGrantContract(template).violations, []);

const sqliteProgram = migrationSqlSource('bots/claude/migrations/fixture.ts', `
  const Database = require('better-sqlite3');
  db.exec(\`CREATE TABLE local_only (id INTEGER PRIMARY KEY AUTOINCREMENT)\`);
`);
assert.equal(sqliteProgram.skipped, true);
assert.deepEqual(sqliteProgram.violations, []);

const postgresConcatenatedProgram = migrationSqlSource('bots/reservation/migrations/fixture.ts', `
  const pgPool = require('../../../packages/core/lib/pg-pool');
  const SCHEMA = 'reservation';
  pgPool.run(SCHEMA, 'CREATE TABLE reservation.' + 'static_table (id bigint); '
    + 'GRANT USAGE ON SCHEMA reservation TO hub_readonly; '
    + 'GRANT SELECT ON TABLE reservation.static_table TO hub_readonly;');
`);
assert.equal(postgresConcatenatedProgram.skipped, false);
assert.deepEqual(postgresConcatenatedProgram.violations, []);
assert.deepEqual(analyzeMigrationGrantContract(postgresConcatenatedProgram.sql).violations, []);

const postgresDynamicProgram = migrationSqlSource('bots/reservation/migrations/fixture.ts', `
  const pgPool = require('../../../packages/core/lib/pg-pool');
  const SCHEMA = 'reservation';
  const SQL = ['CREATE', 'TABLE reservation.dynamic_table (id bigint)'].join(' ');
  pgPool.run(SCHEMA, SQL);
`);
assert.deepEqual(postgresDynamicProgram.violations.map((row) => row.code), [
  'postgres_sql_argument_not_static',
]);

const postgresNamedImportProgram = migrationSqlSource('bots/reservation/migrations/fixture.ts', `
  import { run } from '../../../packages/core/lib/pg-pool';
  run('reservation', 'CREATE TABLE reservation.named_import (id bigint)');
`);
assert.deepEqual(postgresNamedImportProgram.violations.map((row) => row.code), [
  'postgres_driver_unrecognized',
]);

const postgresComputedSinkProgram = migrationSqlSource('bots/reservation/migrations/fixture.ts', `
  const pgPool = require('../../../packages/core/lib/pg-pool');
  const method = 'run';
  pgPool[method]('reservation', 'CREATE ' + 'TABLE reservation.computed_sink (id bigint)');
`);
assert.deepEqual(postgresComputedSinkProgram.violations.map((row) => row.code), [
  'postgres_sql_sink_unverifiable',
]);

const postgresStaticComputedProgram = migrationSqlSource('bots/reservation/migrations/fixture.ts', `
  const pgPool = require('../../../packages/core/lib/pg-pool');
  pgPool['r' + 'un']('reservation', 'CREATE ' + 'TABLE reservation.static_computed (id bigint)');
`);
assert.deepEqual(postgresStaticComputedProgram.violations, []);
assert.deepEqual(
  analyzeMigrationGrantContract(postgresStaticComputedProgram.sql).violations.map((row) => row.code),
  ['schema_usage_grant_missing', 'table_select_grant_missing'],
);

const postgresTransactionProgram = migrationSqlSource('bots/reservation/migrations/fixture.ts', `
  const pgPool = require('../../../packages/core/lib/pg-pool');
  pgPool.transaction('reservation', async (client) => {
    await client.query('CREATE TABLE reservation.transaction_table (id bigint)');
  });
`);
assert.deepEqual(postgresTransactionProgram.violations.map((row) => row.code), [
  'postgres_transaction_callback_unverifiable',
]);

const postgresDestructuredProgram = migrationSqlSource('bots/reservation/migrations/fixture.ts', `
  const { run } = require('../../../packages/core/lib/pg-pool');
  run('reservation', 'CREATE TABLE reservation.destructured (id bigint)');
`);
assert.deepEqual(postgresDestructuredProgram.violations.map((row) => row.code), [
  'postgres_driver_unrecognized',
]);

const statements: string[] = [];
let scopeReads = 0;
const fakeClient = {
  async query(sql: string) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    statements.push(normalized);
    if (/^BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY$/i.test(normalized)) return { rows: [] };
    if (/^ROLLBACK$/i.test(normalized)) return { rows: [] };
    if (/SHOW transaction_read_only/i.test(normalized)) return { rows: [{ transaction_read_only: 'on' }] };
    if (/AS current_user_name/i.test(normalized)) return { rows: [{ current_user_name: 'fixture_auditor' }] };
    if (/AS expected_role_name/i.test(normalized)) {
      return { rows: [{
        role_name: 'hub_readonly',
        role_exists: true,
        is_superuser: false,
        can_create_role: false,
        can_create_db: false,
        can_replicate: false,
        can_bypass_rls: false,
      }] };
    }
    if (/AS scope_relation_count/i.test(normalized)) {
      scopeReads += 1;
      return { rows: [{ scope_schema_count: '2', scope_relation_count: '3', acl_fingerprint: 'fixture-acl' }] };
    }
    if (/AS relation_count/i.test(normalized) && /GROUP BY/i.test(normalized)) {
      return { rows: [
        { schema_name: 'investment', relation_count: '2' },
        { schema_name: 'legal', relation_count: '1' },
      ] };
    }
    if (/has_schema_privilege/i.test(normalized)) {
      return { rows: [
        { role_name: 'hub_readonly', schema_name: 'investment', role_exists: true, has_usage: true },
        { role_name: 'hub_readonly', schema_name: 'hub', role_exists: true, has_usage: true },
        { role_name: 'hub_readonly', schema_name: 'ska', role_exists: true, schema_exists: false, has_usage: false },
      ] };
    }
    if (/has_table_privilege/i.test(normalized)) {
      return { rows: [
        { role_name: 'hub_readonly', schema_name: 'investment', relation_name: 'allowed', relation_kind: 'r', has_select: true },
        { role_name: 'hub_readonly', schema_name: 'investment', relation_name: 'missing.with.dot', relation_kind: 'v', has_select: false },
      ] };
    }
    throw new Error(`unexpected audit SQL: ${normalized}`);
  },
  release() {
    statements.push('RELEASE');
  },
};

async function main() {
  const audit = await runReadOnlyPrivilegeAudit({
    connect: async () => fakeClient,
    policy: HUB_READONLY_GRANT_POLICY,
  });
  assert.equal(audit.readOnly, true);
  assert.equal(audit.scope.unchanged, true);
  assert.equal(audit.checks.roleChecks, 1);
  assert.equal(audit.roles[0]?.elevated, false);
  assert.equal(scopeReads, 2);
  assert.equal(audit.gaps.length, 2);
  assert.deepEqual(audit.gaps.find((gap) => gap.kind === 'schema_missing'), {
    kind: 'schema_missing',
    role: 'hub_readonly',
    schema: 'ska',
  });
  const tableGap = audit.gaps.find((gap) => gap.kind === 'table_select');
  assert.equal(tableGap?.relation, 'investment.missing.with.dot');
  assert.equal(tableGap?.relationName, 'missing.with.dot');
  assert.deepEqual(statements.slice(0, 2), [
    'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    'SHOW transaction_read_only',
  ]);
  assert.deepEqual(statements.slice(-2), ['ROLLBACK', 'RELEASE']);
  assert.equal(statements.every((sql) => (
    /^(?:BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY|SHOW\b|SELECT\b|WITH\b|ROLLBACK$|RELEASE$)/i.test(sql)
  )), true);

  const remediation = renderGrantRemediationDraft(audit, {
    generatedAt: '2026-07-23T00:00:00.000Z',
  });
  assert.match(remediation, /DRAFT ONLY/);
  assert.match(remediation, /GRANT SELECT ON TABLE "investment"\."missing\.with\.dot" TO "hub_readonly";/);
  assert.match(remediation, /ROLLBACK;/);
  assert.doesNotMatch(remediation, /COMMIT;/);

  console.log('migration-grant-contract smoke: PASS');
}

main().catch((error) => {
  console.error('migration-grant-contract smoke: FAIL');
  console.error(error);
  process.exitCode = 1;
});
