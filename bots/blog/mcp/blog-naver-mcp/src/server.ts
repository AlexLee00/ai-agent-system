#!/usr/bin/env node
// @ts-nocheck

import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { calculateNaverSEOScore } = require('../../../lib/naver-seo-optimizer.ts');
const { generateHomeFeedReport } = require('../../../lib/naver-home-feed-optimizer.ts');
const { calculateTrendFusionScore, safeJson } = require('../../../lib/blog-v3-unified.ts');
const pgPool = require('../../../../../packages/core/lib/pg-pool.js');

export const BLOG_NAVER_MCP_TOOLS = [
  {
    name: 'naver_seo_score',
    description: 'Read-only Naver C-Rank/DIA/GEO score for supplied blog draft text.',
  },
  {
    name: 'naver_exposure_audit',
    description: 'Read-only home-feed/exposure audit for supplied blog draft text.',
  },
  {
    name: 'crank_history',
    description: 'Read-only C-Rank history from blog.crank_scores.',
  },
  {
    name: 'trend_topic_candidates',
    description: 'Read-only Blog V3 Reddit/Aladin/Naver trend topic candidates.',
  },
];

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function readCrankHistory(args = {}) {
  const limit = Math.max(1, Math.min(50, Number(args.limit || 10) || 10));
  const postId = args.postId ? Number(args.postId) : null;
  const params = postId ? [postId, limit] : [limit];
  const where = postId ? 'WHERE cs.post_id = $1' : '';
  const sql = `
    SELECT cs.post_id, p.title, cs.scored_date, cs.overall, cs.crank_total, cs.dia_total, cs.geo_total
    FROM blog.crank_scores cs
    LEFT JOIN blog.posts p ON p.id = cs.post_id
    ${where}
    ORDER BY cs.scored_date DESC
    LIMIT $${postId ? 2 : 1}
  `;
  const result = await pgPool.run('blog', sql, params).catch((error) => ({ rows: [], error }));
  return {
    ok: !result.error,
    readOnly: true,
    rows: result.rows || [],
    error: result.error?.message || null,
  };
}

async function readTrendCandidates(args = {}) {
  const limit = Math.max(1, Math.min(50, Number(args.limit || 10) || 10));
  const result = await pgPool.run('blog', `
    SELECT id, date, source, topic_ko, category, trend_score, korea_relevance, is_book_topic, meta, created_at
    FROM blog.trend_topics
    WHERE used = false
    ORDER BY date DESC, trend_score DESC, korea_relevance DESC
    LIMIT $1
  `, [limit]).catch((error) => ({ rows: [], error }));
  const rows = (result.rows || []).map((row) => {
    const meta = safeJson(row.meta);
    const fusion = calculateTrendFusionScore({ ...row, meta });
    return {
      id: row.id,
      date: row.date,
      source: row.source,
      topic: row.topic_ko,
      category: row.category,
      fusionScore: fusion.score,
      trendScore: row.trend_score,
      koreaRelevance: row.korea_relevance,
      evidence: fusion,
    };
  });
  return {
    ok: !result.error,
    readOnly: true,
    rows,
    error: result.error?.message || null,
  };
}

export async function callBlogNaverTool(name, args = {}) {
  if (name === 'naver_seo_score') {
    const title = args.title || 'Blog V3 SEO Draft';
    const content = args.content || '';
    const category = args.category || '최신IT트렌드';
    return {
      ok: true,
      readOnly: true,
      tool: name,
      result: calculateNaverSEOScore({ title, content, category }),
    };
  }
  if (name === 'naver_exposure_audit') {
    const title = args.title || 'Blog V3 Home Feed Draft';
    const content = args.content || '';
    const category = args.category || '최신IT트렌드';
    return {
      ok: true,
      readOnly: true,
      tool: name,
      result: await generateHomeFeedReport({ title, content, category, hasImages: !!args.hasImages }),
    };
  }
  if (name === 'crank_history') return readCrankHistory(args);
  if (name === 'trend_topic_candidates') return readTrendCandidates(args);
  throw new Error(`unknown_tool:${name}`);
}

async function handleRpc(body) {
  const id = body?.id ?? null;
  const method = body?.method;
  const params = body?.params || {};
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: BLOG_NAVER_MCP_TOOLS } };
  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments || params.args || {};
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'json', json: await callBlogNaverTool(name, args) }] } };
  }
  if (BLOG_NAVER_MCP_TOOLS.some((tool) => tool.name === method)) {
    return { jsonrpc: '2.0', id, result: await callBlogNaverTool(method, params) };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method_not_found:${method}` } };
}

export function createBlogNaverMcpServer() {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return json(res, 200, {
          ok: true,
          service: 'blog-naver-mcp',
          mode: 'read_only',
          checkedAt: new Date().toISOString(),
        });
      }
      if (req.method === 'POST' && (req.url === '/' || req.url === '/rpc')) {
        return json(res, 200, await handleRpc(await readBody(req)));
      }
      return json(res, 404, { ok: false, error: 'not_found' });
    } catch (error) {
      return json(res, 500, { ok: false, error: error?.message || String(error) });
    }
  });
}

export async function startServer({ port = null, host = '127.0.0.1' } = {}) {
  const server = createBlogNaverMcpServer();
  const listenPort = Number(port ?? argValue('--port', process.env.BLOG_NAVER_MCP_PORT || 4098));
  await new Promise((resolve) => server.listen(listenPort, host, resolve));
  const address = server.address();
  return { server, port: address.port, host };
}

async function main() {
  const { port, host } = await startServer();
  console.log(JSON.stringify({ ok: true, service: 'blog-naver-mcp', host, port, mode: 'read_only' }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`blog-naver-mcp failed: ${error?.message || error}`);
    process.exit(1);
  });
}
