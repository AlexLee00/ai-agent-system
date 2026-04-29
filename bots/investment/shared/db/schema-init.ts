// @ts-nocheck
/**
 * Investment schema initializer split from shared/db.ts.
 *
 * Keep initSchema as the orchestration boundary; table-family DDL lives under
 * shared/db/schema/tables so future schema work can move one family at a time.
 */

import { run } from './core.ts';
import { runInvestmentSchemaTableFamilies } from './schema/tables/index.ts';

let _schemaInitPromise = null;

export async function initSchema() {
  if (_schemaInitPromise) return _schemaInitPromise;

  _schemaInitPromise = (async () => {
    await runInvestmentSchemaTableFamilies(run);
  })();

  try {
    await _schemaInitPromise;
    return _schemaInitPromise;
  } catch (e) {
    _schemaInitPromise = null;
    throw e;
  }
}

export default { initSchema };
