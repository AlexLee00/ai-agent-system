#!/usr/bin/env tsx

import { createRequire } from 'node:module';
import { fetchVaultKnowledgeGraphReport } from '../vault/vault-knowledge-graph.js';

const require = createRequire(import.meta.url);
const pgPool = require('../../../packages/core/lib/pg-pool') as {
  queryReadonly: (schema: string, sql: string, params?: unknown[]) => Promise<any[]>;
};

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const result = await fetchVaultKnowledgeGraphReport({
  env: process.env,
  entity: argument('entity'),
  limit: Number(argument('limit') || 2000),
  queryReadonly: pgPool.queryReadonly,
});

console.log(JSON.stringify(result, null, 2));
