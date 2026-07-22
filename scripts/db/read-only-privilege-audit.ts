#!/usr/bin/env tsx

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pgPool from '../../packages/core/lib/pg-pool.ts';
import { HUB_READONLY_GRANT_POLICY } from '../../packages/core/lib/migration-grant-contract.ts';

type AuditClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows?: any[] } | any[]>;
  release: () => void;
};

type AuditPolicy = typeof HUB_READONLY_GRANT_POLICY;

function rowsFrom(result: { rows?: any[] } | any[]): any[] {
  return Array.isArray(result) ? result : (Array.isArray(result?.rows) ? result.rows : []);
}

const SCOPE_SQL = `
  SELECT COUNT(DISTINCT n.oid)::text AS scope_schema_count,
         COUNT(c.oid)::text AS scope_relation_count,
         md5(COALESCE(string_agg(
           n.nspname || ':' || COALESCE(n.nspacl::text, '') || ':'
             || COALESCE(c.relname, '') || ':' || COALESCE(c.relacl::text, ''),
           '|' ORDER BY n.nspname, c.relname
         ), '')) AS acl_fingerprint
  FROM pg_catalog.pg_namespace n
  LEFT JOIN pg_catalog.pg_class c
    ON c.relnamespace = n.oid
   AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  WHERE n.nspname = ANY($1::text[])
`;

const SCHEMA_INVENTORY_SQL = `
  SELECT n.nspname AS schema_name, COUNT(c.oid)::text AS relation_count
  FROM pg_catalog.pg_namespace n
  LEFT JOIN pg_catalog.pg_class c
    ON c.relnamespace = n.oid
   AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  WHERE n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
    AND n.nspname <> 'information_schema'
  GROUP BY n.nspname
  ORDER BY n.nspname
`;

const ROLE_STATUS_SQL = `
  WITH expected_roles AS (
    SELECT unnest($1::text[]) AS expected_role_name
  )
  SELECT expected.expected_role_name AS role_name,
         (role_row.oid IS NOT NULL) AS role_exists,
         COALESCE(role_row.rolsuper, false) AS is_superuser,
         COALESCE(role_row.rolcreaterole, false) AS can_create_role,
         COALESCE(role_row.rolcreatedb, false) AS can_create_db,
         COALESCE(role_row.rolreplication, false) AS can_replicate,
         COALESCE(role_row.rolbypassrls, false) AS can_bypass_rls,
         COALESCE((
           SELECT array_agg(parent.rolname ORDER BY parent.rolname)
           FROM pg_catalog.pg_auth_members membership
           JOIN pg_catalog.pg_roles parent ON parent.oid = membership.roleid
           WHERE membership.member = role_row.oid
         ), ARRAY[]::name[])::text[] AS member_of
  FROM expected_roles expected
  LEFT JOIN pg_catalog.pg_roles role_row ON role_row.rolname = expected.expected_role_name
  ORDER BY expected.expected_role_name
`;

const SCHEMA_PRIVILEGE_SQL = `
  WITH expected_roles AS (
    SELECT unnest($1::text[]) AS role_name
  ), expected_schemas AS (
    SELECT unnest($2::text[]) AS schema_name
  )
  SELECT roles.role_name,
         schemas.schema_name,
         (role_row.oid IS NOT NULL) AS role_exists,
         (schema_row.oid IS NOT NULL) AS schema_exists,
         CASE WHEN role_row.oid IS NULL OR schema_row.oid IS NULL THEN false
           ELSE pg_catalog.has_schema_privilege(role_row.oid, schema_row.oid, 'USAGE')
         END AS has_usage,
         CASE WHEN role_row.oid IS NULL OR schema_row.oid IS NULL THEN false
           ELSE pg_catalog.has_schema_privilege(role_row.oid, schema_row.oid, 'CREATE')
         END AS has_create
  FROM expected_roles roles
  CROSS JOIN expected_schemas schemas
  LEFT JOIN pg_catalog.pg_roles role_row ON role_row.rolname = roles.role_name
  LEFT JOIN pg_catalog.pg_namespace schema_row ON schema_row.nspname = schemas.schema_name
  ORDER BY roles.role_name, schemas.schema_name
`;

const TABLE_PRIVILEGE_SQL = `
  WITH expected_roles AS (
    SELECT unnest($1::text[]) AS role_name
  )
  SELECT roles.role_name,
         n.nspname AS schema_name,
         c.relname AS relation_name,
         c.relkind AS relation_kind,
         CASE WHEN role_row.oid IS NULL THEN false
           ELSE pg_catalog.has_table_privilege(role_row.oid, c.oid, 'SELECT')
         END AS has_select,
         CASE WHEN role_row.oid IS NULL THEN false ELSE c.relowner = role_row.oid END AS is_owner,
         CASE WHEN role_row.oid IS NULL THEN false ELSE pg_catalog.has_table_privilege(role_row.oid, c.oid, 'INSERT') END AS has_insert,
         CASE WHEN role_row.oid IS NULL THEN false ELSE pg_catalog.has_table_privilege(role_row.oid, c.oid, 'UPDATE') END AS has_update,
         CASE WHEN role_row.oid IS NULL THEN false ELSE pg_catalog.has_table_privilege(role_row.oid, c.oid, 'DELETE') END AS has_delete,
         CASE WHEN role_row.oid IS NULL THEN false ELSE pg_catalog.has_table_privilege(role_row.oid, c.oid, 'TRUNCATE') END AS has_truncate,
         CASE WHEN role_row.oid IS NULL THEN false ELSE pg_catalog.has_table_privilege(role_row.oid, c.oid, 'REFERENCES') END AS has_references,
         CASE WHEN role_row.oid IS NULL THEN false ELSE pg_catalog.has_table_privilege(role_row.oid, c.oid, 'TRIGGER') END AS has_trigger
  FROM pg_catalog.pg_namespace n
  JOIN pg_catalog.pg_class c
    ON c.relnamespace = n.oid
   AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  CROSS JOIN expected_roles roles
  LEFT JOIN pg_catalog.pg_roles role_row ON role_row.rolname = roles.role_name
  WHERE n.nspname = ANY($2::text[])
  ORDER BY roles.role_name, n.nspname, c.relname
`;

function scopeRow(row: any) {
  return {
    schemas: Number(row?.scope_schema_count || 0),
    relations: Number(row?.scope_relation_count || 0),
    aclFingerprint: String(row?.acl_fingerprint || ''),
  };
}

function relationKind(value: unknown): string {
  return ({ r: 'table', p: 'partitioned_table', v: 'view', m: 'materialized_view', f: 'foreign_table' } as Record<string, string>)[String(value)] || String(value);
}

export async function runReadOnlyPrivilegeAudit({
  connect = async () => pgPool.getPool('public').connect() as Promise<AuditClient>,
  policy = HUB_READONLY_GRANT_POLICY,
}: {
  connect?: () => Promise<AuditClient>;
  policy?: AuditPolicy;
} = {}) {
  const client = await connect();
  let transactionStarted = false;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transactionStarted = true;
    const transactionMode = rowsFrom(await client.query('SHOW transaction_read_only'))[0]?.transaction_read_only;
    if (transactionMode !== 'on') throw new Error('privilege_audit_transaction_not_read_only');

    const currentUser = String(rowsFrom(await client.query(
      'SELECT current_user::text AS current_user_name',
    ))[0]?.current_user_name || 'unknown');
    const before = scopeRow(rowsFrom(await client.query(SCOPE_SQL, [policy.schemas]))[0]);
    const schemaInventoryRows = rowsFrom(await client.query(SCHEMA_INVENTORY_SQL));
    const roleStatusRows = rowsFrom(await client.query(ROLE_STATUS_SQL, [[policy.role]]));
    const schemaPrivilegeRows = rowsFrom(await client.query(
      SCHEMA_PRIVILEGE_SQL,
      [[policy.role], policy.schemas],
    ));
    const tablePrivilegeRows = rowsFrom(await client.query(
      TABLE_PRIVILEGE_SQL,
      [[policy.role], policy.schemas],
    ));
    const after = scopeRow(rowsFrom(await client.query(SCOPE_SQL, [policy.schemas]))[0]);
    const unchanged = JSON.stringify(before) === JSON.stringify(after);
    if (!unchanged) throw new Error('privilege_audit_scope_changed');

    const gaps: Array<Record<string, unknown>> = [];
    const roles = roleStatusRows.map((row) => {
      const memberships = Array.isArray(row.member_of) ? row.member_of.map(String) : [];
      const elevated = [
        row.is_superuser,
        row.can_create_role,
        row.can_create_db,
        row.can_replicate,
        row.can_bypass_rls,
      ].some((value) => value === true) || memberships.length > 0;
      return {
        role: String(row.role_name),
        exists: row.role_exists === true,
        elevated,
        memberOf: memberships,
      };
    });
    const missingRoles = new Set(roles.filter((row) => !row.exists).map((row) => row.role));
    for (const role of roles.filter((row) => row.elevated)) {
      gaps.push({ kind: 'role_elevated', role: role.role, memberOf: role.memberOf });
    }
    for (const row of schemaPrivilegeRows) {
      if (row.schema_exists === false) {
        gaps.push({
          kind: 'schema_missing',
          role: String(row.role_name),
          schema: String(row.schema_name),
        });
        continue;
      }
      if (row.role_exists === false) continue;
      if (row.has_usage !== true) {
        gaps.push({
          kind: 'schema_usage',
          role: String(row.role_name),
          schema: String(row.schema_name),
          privilege: 'USAGE',
        });
      }
      if (row.has_create === true) {
        gaps.push({
          kind: 'unexpected_schema_privilege',
          role: String(row.role_name),
          schema: String(row.schema_name),
          privilege: 'CREATE',
        });
      }
    }
    for (const role of [...missingRoles].sort()) {
      gaps.unshift({ kind: 'role_missing', role });
    }
    if (missingRoles.size === 0) {
      for (const row of tablePrivilegeRows) {
        if (row.has_select !== true) {
          gaps.push({
            kind: 'table_select',
            role: String(row.role_name),
            schema: String(row.schema_name),
            relationName: String(row.relation_name),
            relation: `${row.schema_name}.${row.relation_name}`,
            relationKind: relationKind(row.relation_kind),
            privilege: 'SELECT',
          });
        }
        const unexpected = [
          ['OWNER', row.is_owner],
          ['INSERT', row.has_insert],
          ['UPDATE', row.has_update],
          ['DELETE', row.has_delete],
          ['TRUNCATE', row.has_truncate],
          ['REFERENCES', row.has_references],
          ['TRIGGER', row.has_trigger],
        ].filter(([, granted]) => granted === true).map(([privilege]) => privilege);
        if (unexpected.length > 0) {
          gaps.push({
            kind: 'unexpected_table_privilege',
            role: String(row.role_name),
            schema: String(row.schema_name),
            relationName: String(row.relation_name),
            relation: `${row.schema_name}.${row.relation_name}`,
            relationKind: relationKind(row.relation_kind),
            privileges: unexpected,
          });
        }
      }
    }

    const approvedSchemas = new Set(policy.schemas);
    const schemas = schemaInventoryRows.map((row) => ({
      schema: String(row.schema_name),
      relations: Number(row.relation_count || 0),
      expected: approvedSchemas.has(String(row.schema_name)),
    }));
    return {
      readOnly: true,
      transactionMode,
      currentUser,
      policy: {
        role: policy.role,
        schemas: [...policy.schemas],
        schemaPrivileges: [...policy.schemaPrivileges],
        relationPrivileges: [...policy.relationPrivileges],
      },
      scope: { before, after, unchanged },
      roles,
      schemas,
      checks: {
        roleChecks: roleStatusRows.length,
        schemaRoleChecks: schemaPrivilegeRows.length,
        relationRoleChecks: tablePrivilegeRows.length,
      },
      gaps,
    };
  } finally {
    try {
      if (transactionStarted) await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }
}

function quoteIdentifier(value: unknown): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}

export function renderGrantRemediationDraft(
  audit: Awaited<ReturnType<typeof runReadOnlyPrivilegeAudit>>,
  { generatedAt = new Date().toISOString() }: { generatedAt?: string } = {},
): string {
  const evidenceSha = crypto.createHash('sha256')
    .update(JSON.stringify({ policy: audit.policy, scope: audit.scope, gaps: audit.gaps }))
    .digest('hex');
  const schemaStatements = new Set<string>();
  const tableStatements = new Set<string>();
  const reviewNotes = new Set<string>();
  for (const gap of audit.gaps) {
    if (gap.kind === 'schema_usage') {
      schemaStatements.add(`GRANT USAGE ON SCHEMA ${quoteIdentifier(gap.schema)} TO ${quoteIdentifier(gap.role)};`);
    } else if (gap.kind === 'table_select') {
      if (typeof gap.schema !== 'string' || typeof gap.relationName !== 'string') {
        reviewNotes.add(`-- MANUAL REVIEW REQUIRED: ${JSON.stringify(gap)}`);
        continue;
      }
      tableStatements.add(`GRANT SELECT ON TABLE ${quoteIdentifier(gap.schema)}.${quoteIdentifier(gap.relationName)} TO ${quoteIdentifier(gap.role)};`);
    } else {
      reviewNotes.add(`-- MANUAL REVIEW REQUIRED: ${JSON.stringify(gap)}`);
    }
  }
  return [
    '-- DRAFT ONLY. Generated from a read-only privilege audit; never auto-executed.',
    '-- Master review is required. This draft intentionally ends with ROLLBACK.',
    `-- generated_at: ${generatedAt}`,
    `-- audit_evidence_sha256: ${evidenceSha}`,
    '',
    'BEGIN;',
    ...[...reviewNotes].sort(),
    ...[...schemaStatements].sort(),
    ...[...tableStatements].sort(),
    'ROLLBACK;',
    '',
  ].join('\n');
}

function argValue(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || '';
}

async function main() {
  try {
    const audit = await runReadOnlyPrivilegeAudit();
    const remediationOutput = argValue('remediation-output');
    let remediationDraft: string | null = null;
    if (remediationOutput && audit.gaps.length > 0) {
      remediationDraft = path.resolve(remediationOutput);
      await fs.promises.mkdir(path.dirname(remediationDraft), { recursive: true });
      await fs.promises.writeFile(
        remediationDraft,
        renderGrantRemediationDraft(audit),
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      );
    }
    console.log(JSON.stringify({ ...audit, remediationDraft }, null, 2));
  } finally {
    await pgPool.closeAll();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: any) => {
    console.error(`[read-only-privilege-audit] ${error?.message || error}`);
    process.exitCode = 1;
  });
}
