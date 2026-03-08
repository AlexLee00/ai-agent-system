'use strict';

/**
 * packages/core/lib/rag-server.js — RAG HTTP API 서버 (포트 8100)
 *
 * 기존 ~/projects/rag-system/ (Python FastAPI + ChromaDB) 대체
 * OpenClaw TOOLS.md의 search_rag 호출과 호환 유지:
 *   POST http://localhost:8100/search
 *   POST http://localhost:8100/add
 *   GET  http://localhost:8100/collections
 *
 * 실행: node packages/core/lib/rag-server.js
 * launchd: ai.rag.server
 */

const http = require('http');
const rag  = require('./rag');

const PORT = process.env.RAG_PORT || 8100;

// ── JSON 파싱 헬퍼 ──────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(new Error('JSON 파싱 실패')); }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, statusCode, body) {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

// ── 라우터 ──────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const url    = req.url.split('?')[0];
  const method = req.method.toUpperCase();

  try {
    // ── GET /collections ──────────────────────────────────────────
    if (method === 'GET' && url === '/collections') {
      // 각 컬렉션의 문서 수 조회
      const result = {};
      for (const table of rag.VALID_COLLECTIONS) {
        const name = table.replace(/^rag_/, '');
        try {
          const s = await rag.stats(table);
          result[name] = s.total;
        } catch { result[name] = 0; }
      }
      return sendJSON(res, 200, result);
    }

    // ── GET /health ────────────────────────────────────────────────
    if (method === 'GET' && (url === '/health' || url === '/')) {
      return sendJSON(res, 200, { status: 'ok', engine: 'pgvector', port: PORT });
    }

    // ── POST /search ───────────────────────────────────────────────
    if (method === 'POST' && url === '/search') {
      const body = await readBody(req);
      const { collection, query, k = 5, filter = null } = body;

      if (!collection || !query) {
        return sendJSON(res, 400, { error: 'collection, query 필수' });
      }

      const hits = await rag.search(collection, query, { limit: k, filter });
      // ChromaDB 응답 형식과 호환 (OpenClaw 기존 파서 호환)
      return sendJSON(res, 200, {
        results: hits.map(h => ({
          document: h.content,
          metadata: h.metadata,
          distance: 1 - h.similarity,   // cosine distance (ChromaDB 방식)
          id:       String(h.id),
        })),
        total: hits.length,
        collection,
      });
    }

    // ── POST /add ─────────────────────────────────────────────────
    if (method === 'POST' && url === '/add') {
      const body = await readBody(req);
      const { collection, texts, metadatas = [], source_bot = 'api' } = body;

      if (!collection || !Array.isArray(texts) || texts.length === 0) {
        return sendJSON(res, 400, { error: 'collection, texts[] 필수' });
      }

      const items = texts.map((content, i) => ({
        content,
        metadata: metadatas[i] || {},
      }));
      const ids = await rag.storeBatch(collection, items, source_bot);
      return sendJSON(res, 200, { added: ids.length, ids });
    }

    // ── POST /delete ───────────────────────────────────────────────
    if (method === 'POST' && url === '/delete') {
      const body = await readBody(req);
      const { collection, days = 30 } = body;
      if (!collection) return sendJSON(res, 400, { error: 'collection 필수' });
      const deleted = await rag.cleanOld(collection, days);
      return sendJSON(res, 200, { deleted });
    }

    // ── POST /stats ────────────────────────────────────────────────
    if (method === 'POST' && url === '/stats') {
      const body = await readBody(req);
      const { collection } = body;
      if (!collection) return sendJSON(res, 400, { error: 'collection 필수' });
      const s = await rag.stats(collection);
      return sendJSON(res, 200, s);
    }

    sendJSON(res, 404, { error: `알 수 없는 경로: ${method} ${url}` });

  } catch (e) {
    console.error(`[rag-server] 오류 ${method} ${url}:`, e.message);
    sendJSON(res, 500, { error: e.message });
  }
}

// ── 서버 시작 ────────────────────────────────────────────────────────

async function start() {
  // 스키마 초기화 (테이블·인덱스 없으면 생성)
  await rag.initSchema();

  const server = http.createServer(handleRequest);

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[rag-server] ✅ 포트 ${PORT} 대기 중 (pgvector ${rag.EMBED_MODEL})`);
    console.log(`[rag-server] 컬렉션: ${rag.VALID_COLLECTIONS.map(t => t.replace('rag_', '')).join(', ')}`);
  });

  server.on('error', e => {
    if (e.code === 'EADDRINUSE') {
      console.error(`[rag-server] ❌ 포트 ${PORT} 이미 사용 중 — 기존 서버 종료 후 재시작`);
    } else {
      console.error('[rag-server] ❌ 서버 오류:', e.message);
    }
    process.exit(1);
  });
}

start().catch(e => {
  console.error('[rag-server] 시작 실패:', e.message);
  process.exit(1);
});
