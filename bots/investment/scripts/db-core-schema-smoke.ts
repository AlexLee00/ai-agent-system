#!/usr/bin/env node
// @ts-nocheck

import * as facade from '../shared/db.ts';
import * as core from '../shared/db/core.ts';
import * as schema from '../shared/db/schema.ts';

const checks = [
  ['query', facade.query === core.query],
  ['run', facade.run === core.run],
  ['get', facade.get === core.get],
  ['withTransaction', facade.withTransaction === core.withTransaction],
  ['initSchema', typeof facade.initSchema === 'function'],
  ['schema-name', schema.INVESTMENT_SCHEMA === core.INVESTMENT_SCHEMA && core.INVESTMENT_SCHEMA === 'investment'],
  ['schema-helper', schema.normalizeInvestmentTableName('investment.Signals') === 'signals'],
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length > 0) {
  throw new Error(`db core/schema compatibility failed: ${failed.map(([name]) => name).join(', ')}`);
}

const payload = {
  ok: true,
  smoke: 'db-core-schema',
  checks: Object.fromEntries(checks),
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('✅ db core/schema smoke passed');
}
