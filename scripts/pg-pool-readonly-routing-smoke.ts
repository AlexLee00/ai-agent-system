#!/usr/bin/env tsx

import assert from 'node:assert/strict';

const pgPool = require('../packages/core/lib/pg-pool.ts');
const { isReadOnlySql } = pgPool._testOnly || {};

assert.equal(typeof isReadOnlySql, 'function', 'pg-pool must expose the read-only classifier for regression testing');
assert.equal(isReadOnlySql('SELECT 1'), true);
assert.equal(isReadOnlySql('WITH sample AS (SELECT 1) SELECT * FROM sample'), true);
assert.equal(isReadOnlySql(`
  WITH picked AS (
    SELECT incident_key
    FROM agent.jay_incidents
    WHERE status = 'queued'
    FOR UPDATE SKIP LOCKED
  )
  UPDATE agent.jay_incidents dst
  SET status = 'planning'
  FROM picked
  WHERE dst.incident_key = picked.incident_key
  RETURNING dst.*
`), false, 'writable CTEs must use the direct writer pool');
assert.equal(isReadOnlySql("SELECT 'update agent.registry' AS example"), true, 'keywords inside literals must not change routing');
assert.equal(isReadOnlySql('EXPLAIN ANALYZE UPDATE agent.registry SET score = score'), false);

console.log('pg_pool_readonly_routing_smoke_ok');
