// @ts-nocheck
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const rag = require('../../../packages/core/lib/rag-safe');

export function getRagGuardStatus() {
  return rag.getRagGuardStatus();
}

export async function initSchema() {
  return rag.initSchema();
}

export async function search(collection, query, opts = {}, meta = {}) {
  return rag.search(collection, query, opts, meta);
}

export async function store(collection, content, metadata = {}, sourceBot = 'luna') {
  return rag.store(collection, content, metadata, sourceBot);
}

export async function storeBatch(collection, items, sourceBot = 'luna') {
  return rag.storeBatch(collection, items, sourceBot);
}
