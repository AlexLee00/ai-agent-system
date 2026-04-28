#!/usr/bin/env tsx
import assert from 'node:assert/strict';

const {
  resolvePgRoleMapping,
  validatePgRoleMapping,
} = require('../lib/pg-role-mapping.ts');

const direct = resolvePgRoleMapping({
  PG_DIRECT: 'true',
  PG_USER: 'jay_writer',
  PG_DATABASE: 'jay',
});
assert.equal(direct.mode, 'direct_writer');
assert.equal(direct.directWriter.user, 'jay_writer');
assert.deepEqual(direct.schemas.writer, ['agent', 'claude']);
assert.equal(validatePgRoleMapping(direct).ok, true);

const readonly = resolvePgRoleMapping({
  HUB_BASE_URL: 'http://127.0.0.1:7788',
  HUB_PG_USER: 'hub_readonly',
  HUB_PG_DATABASE: 'jay',
});
assert.equal(readonly.mode, 'hub_readonly');
assert.equal(readonly.hubReadonly.configured, true);
assert.equal(readonly.directWriter.enabled, false);

const fallback = resolvePgRoleMapping({});
assert.equal(fallback.mode, 'direct_default');
assert.ok(validatePgRoleMapping(fallback).warnings.includes('hub_readonly_not_configured_using_direct_default'));

console.log('pg_role_mapping_smoke_ok');
