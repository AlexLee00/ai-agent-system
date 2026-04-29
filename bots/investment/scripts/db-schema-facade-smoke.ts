#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import dbDefault, * as facade from '../shared/db.ts';
import * as schemaInit from '../shared/db/schema-init.ts';
import * as schema from '../shared/db/schema.ts';

assert.equal(facade.initSchema, schemaInit.initSchema, 'named initSchema should come from split schema-init module');
assert.equal(dbDefault.initSchema, schemaInit.initSchema, 'default initSchema should come from split schema-init module');
assert.equal(typeof schema.normalizeInvestmentTableName, 'function', 'schema helper should remain importable');
assert.equal(schema.normalizeInvestmentTableName('investment.signals'), 'signals');

const payload = {
  ok: true,
  smoke: 'db-schema-facade',
  initSchemaFacade: facade.initSchema === schemaInit.initSchema,
  initSchemaDefault: dbDefault.initSchema === schemaInit.initSchema,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('db-schema-facade-smoke ok');
}
