#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';

import { shouldLogInvestmentSchemaBootstrap } from '../shared/db/schema/tables/bootstrap.ts';
import { shouldLogJournalSchemaInit } from '../shared/trade-journal-db.ts';

assert.equal(
  shouldLogInvestmentSchemaBootstrap({ argv: ['node', 'health-report.ts'], env: {} }),
  true,
  'investment schema bootstrap should keep human-readable logs by default',
);
assert.equal(
  shouldLogInvestmentSchemaBootstrap({ argv: ['node', 'health-report.ts', '--json'], env: {} }),
  false,
  'investment schema bootstrap must not pollute JSON stdout',
);
assert.equal(
  shouldLogInvestmentSchemaBootstrap({ argv: ['node', 'health-report.ts'], env: { LUNA_SCHEMA_INIT_LOGS: 'false' } }),
  false,
  'investment schema bootstrap logs should honor LUNA_SCHEMA_INIT_LOGS=false',
);
assert.equal(
  shouldLogJournalSchemaInit({ argv: ['node', 'health-report.ts'], env: {} }),
  true,
  'trade journal schema init should keep human-readable logs by default',
);
assert.equal(
  shouldLogJournalSchemaInit({ argv: ['node', 'health-report.ts', '--json'], env: {} }),
  false,
  'trade journal schema init must not pollute JSON stdout',
);
assert.equal(
  shouldLogJournalSchemaInit({ argv: ['node', 'health-report.ts'], env: { LUNA_SCHEMA_INIT_LOGS: 'false' } }),
  false,
  'trade journal schema init logs should honor LUNA_SCHEMA_INIT_LOGS=false',
);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ok: true, smoke: 'luna-health-json-log-suppression' }, null, 2));
} else {
  console.log('luna health json log suppression smoke ok');
}
