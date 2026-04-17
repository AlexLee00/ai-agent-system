#!/usr/bin/env node
// @ts-nocheck

import { createRequire } from 'module';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const require = createRequire(import.meta.url);
const pgPool = require('../../../packages/core/lib/pg-pool.js');
const { getEmbeddingsUrl } = require('../../../packages/core/lib/local-llm-client.js');

const DEFAULT_MODELS = [
  'qwen3-embed-0.6b',
  'qwen2.5-7b',
  'deepseek-r1-32b',
  'gemma4:latest',
];

const DEFAULT_QUERIES = [
  '샤프 비율이 높은 백테스트 전략 찾기',
  '리스크 관리와 손절 전략이 포함된 트레이딩 연구',
  '디지털 포렌식 벤치마크와 코드 평가 연구',
];

function parseArgs(argv = []) {
  const args = {
    models: [],
    queries: [],
    limit: 3,
    json: false,
  };

  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw.startsWith('--model=')) args.models.push(raw.split('=').slice(1).join('='));
    else if (raw.startsWith('--query=')) args.queries.push(raw.split('=').slice(1).join('='));
    else if (raw.startsWith('--limit=')) args.limit = Math.max(1, Number(raw.split('=').slice(1).join('=') || 3));
  }

  if (args.models.length === 0) args.models = [...DEFAULT_MODELS];
  if (args.queries.length === 0) args.queries = [...DEFAULT_QUERIES];
  return args;
}

async function fetchAvailableModels() {
  const baseUrl = String(process.env.LOCAL_LLM_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const resp = await fetch(`${baseUrl}/v1/models`);
  if (!resp.ok) throw new Error(`models HTTP ${resp.status}`);
  const payload = await resp.json();
  return Array.isArray(payload?.data) ? payload.data.map((row) => row.id).filter(Boolean) : [];
}

async function createEmbedding(model, input) {
  const url = getEmbeddingsUrl();
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input }),
    signal: AbortSignal.timeout(15000),
  });

  const text = await resp.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    // keep raw text below
  }

  if (!resp.ok) {
    const detail = payload?.error?.message || text || `HTTP ${resp.status}`;
    throw new Error(`HTTP ${resp.status}: ${detail}`);
  }

  const embedding = payload?.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error('embedding missing');
  }
  return embedding;
}

async function searchRagResearch(query, embedding, limit = 3) {
  const vecStr = `[${embedding.join(',')}]`;
  return pgPool.queryReadonly(
    'reservation',
    `
      SELECT id,
             left(content, 140) AS snippet,
             1 - (embedding <=> $1::vector) AS similarity,
             created_at
      FROM reservation.rag_research
      ORDER BY embedding <=> $1::vector
      LIMIT $2::int
    `,
    [vecStr, limit],
  );
}

async function evaluateModel(model, queries, limit) {
  const result = {
    model,
    ok: true,
    embeddingDim: null,
    queries: [],
    error: null,
  };

  try {
    for (const query of queries) {
      const embedding = await createEmbedding(model, query);
      result.embeddingDim = embedding.length;
      const hits = await searchRagResearch(query, embedding, limit);
      result.queries.push({
        query,
        topHits: hits.map((row) => ({
          id: row.id,
          similarity: Number(row.similarity || 0),
          snippet: row.snippet,
        })),
      });
    }
  } catch (error) {
    result.ok = false;
    result.error = error?.message || String(error);
  }

  return result;
}

function renderText(report) {
  const lines = [
    '🧪 MLX 임베딩 모델 평가',
    `- endpoint: ${report.endpoint}`,
    `- available: ${report.availableModels.join(', ') || 'none'}`,
    '',
  ];

  for (const item of report.results) {
    if (!item.ok) {
      lines.push(`❌ ${item.model}: ${item.error}`);
      lines.push('');
      continue;
    }
    lines.push(`✅ ${item.model}: embedding_dim=${item.embeddingDim}`);
    for (const q of item.queries) {
      lines.push(`  - query: ${q.query}`);
      for (const hit of q.topHits) {
        lines.push(`    • sim=${hit.similarity.toFixed(4)} | ${hit.snippet}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const endpoint = getEmbeddingsUrl();
  const availableModels = await fetchAvailableModels();

  const results = [];
  for (const model of args.models) {
    results.push(await evaluateModel(model, args.queries, args.limit));
  }

  const report = {
    ok: true,
    endpoint,
    availableModels,
    results,
  };

  if (args.json) return report;
  return renderText(report);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    onSuccess: async (result) => {
      if (typeof result === 'string') console.log(result);
      else console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: '❌ evaluate-embedding-models 오류:',
  });
}

