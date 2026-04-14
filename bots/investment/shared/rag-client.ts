// @ts-nocheck
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const rag = require('../../../packages/core/lib/rag-safe');
const { publishToRag } = require('../../../packages/core/lib/reporting-hub');

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
  const eventType = String(metadata?.event_type || metadata?.eventType || `${collection}_rag`);
  const symbol = metadata?.symbol ? String(metadata.symbol) : null;
  const status = metadata?.status ? String(metadata.status) : null;
  const summaryParts = [
    symbol,
    status ? `상태 ${status}` : null,
  ].filter(Boolean);

  const result = await publishToRag({
    ragStore: {
      async store(targetCollection, ragContent, targetMetadata = {}, targetSourceBot = sourceBot) {
        return rag.store(targetCollection, ragContent, targetMetadata, targetSourceBot);
      },
    },
    collection,
    sourceBot,
    event: {
      from_bot: sourceBot,
      team: 'investment',
      event_type: eventType,
      alert_level: 1,
      message: String(content || '').slice(0, 400),
      payload: {
        title: symbol ? `${symbol} RAG 저장` : `${collection} RAG 저장`,
        summary: summaryParts.join(' | ') || `${collection} 저장`,
        details: [
          `collection: ${collection}`,
          ...(symbol ? [`symbol: ${symbol}`] : []),
          ...(status ? [`status: ${status}`] : []),
        ],
      },
    },
    metadata,
    contentBuilder: () => String(content || ''),
    policy: {
      dedupe: true,
      key: `investment-rag:${collection}:${sourceBot}:${metadata?.signal_id || metadata?.postId || metadata?.id || String(content || '').slice(0, 80)}`,
      cooldownMs: 30 * 60 * 1000,
    },
  });

  return result?.id ?? null;
}

export async function storeBatch(collection, items, sourceBot = 'luna') {
  const results = [];
  for (const item of Array.isArray(items) ? items : []) {
    results.push(await store(collection, item?.content || '', item?.metadata || {}, sourceBot));
  }
  return results;
}
