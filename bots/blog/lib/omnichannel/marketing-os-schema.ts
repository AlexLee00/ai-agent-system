'use strict';

/**
 * bots/blog/lib/omnichannel/marketing-os-schema.ts
 *
 * 021 migration(SQL)을 런타임에서 보장하는 경량 bootstrap.
 * queue-first 경로가 relation missing으로 fallback만 타는 상황을 막는다.
 */

const fs = require('fs');
const path = require('path');
const env = require('../../../../packages/core/lib/env');
const pgPool = require('../../../../packages/core/lib/pg-pool');

let schemaEnsured = false;

async function ensureMarketingOsSchema() {
  if (schemaEnsured) return;

  const migrationPath = path.join(
    env.PROJECT_ROOT,
    'bots/blog/migrations/021-omnichannel-marketing-os.sql'
  );

  try {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    if (!sql || !sql.trim()) throw new Error('empty_migration_sql');
    await pgPool.run('blog', 'CREATE SCHEMA IF NOT EXISTS blog');
    await pgPool.query('blog', sql);
    schemaEnsured = true;
  } catch (error) {
    // queue path 자체를 죽이지 않고 상위에서 fallback 판단 가능하게 전달.
    throw new Error(`marketing_os_schema_bootstrap_failed: ${String(error?.message || error)}`);
  }
}

module.exports = {
  ensureMarketingOsSchema,
};

