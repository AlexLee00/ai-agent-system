// @ts-nocheck

import { INVESTMENT_SCHEMA_BOOTSTRAP_FAMILY, runInvestmentSchemaBootstrap } from './bootstrap.ts';

export const INVESTMENT_SCHEMA_TABLE_FAMILIES = [
  { name: INVESTMENT_SCHEMA_BOOTSTRAP_FAMILY, run: runInvestmentSchemaBootstrap },
];

export async function runInvestmentSchemaTableFamilies(run, { families = INVESTMENT_SCHEMA_TABLE_FAMILIES, log = true } = {}) {
  const executed = [];
  for (const family of families) {
    await family.run(run, { log });
    executed.push(family.name);
  }
  return executed;
}

export default {
  INVESTMENT_SCHEMA_TABLE_FAMILIES,
  runInvestmentSchemaTableFamilies,
};
