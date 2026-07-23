#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { validateSchema } from '../lib/sql-guard.ts';

for (const schema of ['agent', 'claude', 'reservation', 'investment', 'ska', 'blog', 'sigma', 'public']) {
  assert.deepEqual(validateSchema(schema), { ok: true, schema });
}

assert.deepEqual(validateSchema('legal'), { ok: false, reason: 'invalid schema: legal' });
assert.deepEqual(validateSchema('sigma;drop schema public'), {
  ok: false,
  reason: 'invalid schema: sigma;drop schema public',
});

console.log('hub_pg_schema_contract_smoke_ok');
