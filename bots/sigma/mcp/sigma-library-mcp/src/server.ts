#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { searchVault } from '../../../vault/vault-search.ts';
import { normalizeLibraryCoords } from '../../../shared/library-coords.ts';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../../..');
const pgPool = require(path.join(repoRoot, 'packages/core/lib/pg-pool.ts'));

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4097;
const DEFAULT_WIKI_DIR = path.join(os.homedir(), 'project-docs/ai-agent-system/wiki');
const COORD_COLUMNS = ['abstraction_level', 'time_stage', 'validation_state', 'prediction_state', 'prediction_horizon'];

export const SIGMA_LIBRARY_MCP_TOOLS = [
  {
    name: 'library-search',
    description: 'Search Sigma vault with optional coordinate routing. Read-only.',
  },
  {
    name: 'library-wiki',
    description: 'Read generated Sigma wiki pages by topic. File read-only.',
  },
  {
    name: 'library-predictions',
    description: 'Return prediction ledger rows and validation accuracy from Sigma vault. SELECT-only.',
  },
  {
    name: 'library-coords',
    description: 'Return coordinate distribution for Sigma vault entries. SELECT-only.',
  },
];

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function normalizeRows(rows) {
  return Array.isArray(rows) ? rows : rows?.rows ?? [];
}

function parseMeta(meta) {
  if (!meta) return {};
  if (typeof meta === 'object') return meta;
  try {
    return JSON.parse(String(meta));
  } catch {
    return {};
  }
}

function assertReadonlySql(sql) {
  const normalized = String(sql || '').trim();
  if (!/^(SELECT|WITH)\b/i.test(normalized)) {
    throw new Error('readonly_sql_required');
  }
  if (/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|MERGE|CALL)\b/i.test(normalized)) {
    throw new Error('write_sql_forbidden');
  }
}

async function readonlyQuery(schema, sql, params = [], deps = {}) {
  assertReadonlySql(sql);
  const queryReadonly = deps.queryReadonly || pgPool.queryReadonly;
  return normalizeRows(await queryReadonly(schema, sql, params));
}

async function coordColumns(deps = {}) {
  const rows = await readonlyQuery('sigma', `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'sigma'
      AND table_name = 'vault_entries'
      AND column_name = ANY($1::text[])
  `, [COORD_COLUMNS], deps).catch(() => []);
  return new Set(rows.map((row) => row.column_name));
}

function pagePath(wikiDir, topic) {
  const safeTopic = String(topic || '').trim().replace(/[^A-Za-z0-9_-]/g, '');
  if (!safeTopic) return null;
  const file = path.join(wikiDir, `${safeTopic}.md`);
  return file.startsWith(path.resolve(wikiDir)) ? file : null;
}

function listWikiPages(wikiDir) {
  if (!fs.existsSync(wikiDir)) return [];
  return fs.readdirSync(wikiDir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => ({
      topic: path.basename(name, '.md'),
      bytes: fs.statSync(path.join(wikiDir, name)).size,
    }));
}

async function buildPredictionLedger(args = {}, deps = {}) {
  const limit = boundedInt(args.limit, 50, 1, 200);
  const columns = await coordColumns(deps);
  const selectCoords = columns.size > 0 ? `, ${[...columns].join(', ')}` : '';
  const stateExpr = columns.has('prediction_state')
    ? `COALESCE(prediction_state, meta->'libraryCoords'->>'prediction_state')`
    : `meta->'libraryCoords'->>'prediction_state'`;
  const rows = await readonlyQuery('sigma', `
    SELECT id, title, source, file_path, meta, created_at${selectCoords}
    FROM sigma.vault_entries
    WHERE ${stateExpr} IN ('forward', 'due', 'resolved')
      AND COALESCE(status, 'captured') <> 'archived'
      AND (meta->>'merged_into') IS NULL
    ORDER BY created_at DESC
    LIMIT $1
  `, [limit], deps).catch(() => []);

  const predictions = rows.map((row) => {
    const meta = parseMeta(row.meta);
    const coords = normalizeLibraryCoords({
      ...(meta.libraryCoords || {}),
      abstraction_level: row.abstraction_level,
      time_stage: row.time_stage,
      validation_state: row.validation_state,
      prediction_state: row.prediction_state,
      prediction_horizon: row.prediction_horizon,
    });
    const team = meta.source_ref?.team || meta.sourceRef?.team || meta.team || row.source || 'unknown';
    return {
      id: row.id,
      title: row.title,
      team,
      source: row.source || null,
      filePath: row.file_path || null,
      createdAt: row.created_at || null,
      predictionOutcome: ['hit', 'miss'].includes(String(meta.prediction_outcome || '').toLowerCase())
        ? String(meta.prediction_outcome).toLowerCase()
        : null,
      coords,
    };
  });
  const outcomeExpr = `LOWER(COALESCE(NULLIF(meta->>'prediction_outcome', ''), ''))`;
  let aggregateRows = [];
  let aggregateSkippedReason = null;
  try {
    aggregateRows = await readonlyQuery('sigma', `
      SELECT LOWER(COALESCE(
               NULLIF(meta->'source_ref'->>'team', ''),
               NULLIF(meta->'sourceRef'->>'team', ''),
               NULLIF(meta->>'team', ''),
               NULLIF(source, ''),
               'unknown'
             )) AS team,
             COUNT(*)::int AS total,
             COUNT(*) FILTER (
               WHERE ${stateExpr} = 'resolved' AND ${outcomeExpr} = 'hit'
             )::int AS validated,
             COUNT(*) FILTER (
               WHERE ${stateExpr} = 'resolved' AND ${outcomeExpr} = 'miss'
             )::int AS contradicted,
             COUNT(*) FILTER (WHERE ${stateExpr} = 'resolved')::int AS resolved,
             COUNT(*) FILTER (
               WHERE ${stateExpr} = 'resolved' AND ${outcomeExpr} IN ('hit', 'miss')
             )::int AS accuracy_samples
      FROM sigma.vault_entries
      WHERE ${stateExpr} IN ('forward', 'due', 'resolved')
        AND COALESCE(status, 'captured') <> 'archived'
        AND (meta->>'merged_into') IS NULL
      GROUP BY 1
      ORDER BY 1
    `, [], deps);
  } catch {
    aggregateSkippedReason = 'prediction_aggregate_query_failed';
  }
  const accuracy = aggregateRows.map((item) => ({
    ...item,
    total: Number(item.total || 0),
    validated: Number(item.validated || 0),
    contradicted: Number(item.contradicted || 0),
    hits: Number(item.validated || 0),
    misses: Number(item.contradicted || 0),
    resolved: Number(item.resolved || 0),
    accuracySamples: Number(item.accuracy_samples || 0),
    accuracy: Number(item.accuracy_samples || 0) > 0
      ? Number(item.validated || 0) / Number(item.accuracy_samples || 0)
      : null,
  }));
  return {
    ok: true,
    mode: 'read_only_select',
    count: predictions.length,
    predictions,
    accuracy,
    accuracyStatus: {
      skipped: Boolean(aggregateSkippedReason),
      reason: aggregateSkippedReason,
      source: aggregateSkippedReason ? null : 'full_aggregate',
    },
  };
}

async function buildCoordSummary(args = {}, deps = {}) {
  const columns = await coordColumns(deps);
  const expr = (column, fallback) => columns.has(column)
    ? `COALESCE(${column}, meta->'libraryCoords'->>'${column}', '${fallback}')`
    : `COALESCE(meta->'libraryCoords'->>'${column}', '${fallback}')`;
  const rows = await readonlyQuery('sigma', `
    SELECT
      ${expr('abstraction_level', 'L0')} AS abstraction_level,
      ${expr('time_stage', 'raw')} AS time_stage,
      ${expr('validation_state', 'unverified')} AS validation_state,
      ${expr('prediction_state', 'none')} AS prediction_state,
      COUNT(*)::int AS count
    FROM sigma.vault_entries
    WHERE COALESCE(status, 'captured') <> 'archived'
      AND (meta->>'merged_into') IS NULL
    GROUP BY 1, 2, 3, 4
    ORDER BY count DESC
    LIMIT $1
  `, [boundedInt(args.limit, 40, 1, 200)], deps).catch(() => []);
  return {
    ok: true,
    mode: 'read_only_select',
    coordColumnsPresent: [...columns].sort(),
    rows,
  };
}

export async function callSigmaLibraryTool(name, args = {}, deps = {}) {
  if (name === 'library-search') {
    const result = await searchVault(String(args.query || ''), {
      topK: args.topK || args.limit || 5,
      sourceKinds: Array.isArray(args.sourceKinds) ? args.sourceKinds : undefined,
      teamNamespaces: Array.isArray(args.teamNamespaces)
        ? args.teamNamespaces
        : args.team
          ? [args.team]
          : undefined,
      intent: args.intent,
      coordFilters: args.coordFilters && typeof args.coordFilters === 'object'
        ? args.coordFilters
        : undefined,
      strictLayerFilters: args.strictLayerFilters === true,
      groupBySourceRef: args.groupBySourceRef === true,
      layerSearchEnabled: Boolean(args.layerSearchEnabled ?? process.env.SIGMA_LAYER_SEARCH_ENABLED === 'true'),
      includeRoutingDebug: true,
      deps,
    });
    return { ...result, mode: 'read_only_search' };
  }
  if (name === 'library-wiki') {
    const wikiDir = deps.wikiDir || DEFAULT_WIKI_DIR;
    if (!args.topic) {
      return {
        ok: true,
        mode: 'file_read_only',
        wikiDir,
        pages: listWikiPages(wikiDir),
      };
    }
    const file = pagePath(wikiDir, args.topic);
    if (!file || !fs.existsSync(file)) return { ok: false, mode: 'file_read_only', error: 'wiki_page_not_found', topic: args.topic };
    return {
      ok: true,
      mode: 'file_read_only',
      topic: String(args.topic),
      content: fs.readFileSync(file, 'utf8').slice(0, boundedInt(args.maxChars, 12000, 100, 50000)),
    };
  }
  if (name === 'library-predictions') return buildPredictionLedger(args, deps);
  if (name === 'library-coords') return buildCoordSummary(args, deps);
  throw new Error(`unknown_tool:${name}`);
}

async function handleRpc(body) {
  const id = body?.id ?? null;
  const method = body?.method;
  const params = body?.params || {};
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: SIGMA_LIBRARY_MCP_TOOLS } };
  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments || params.args || {};
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'json', json: await callSigmaLibraryTool(name, args) }] } };
  }
  if (SIGMA_LIBRARY_MCP_TOOLS.some((tool) => tool.name === method)) {
    return { jsonrpc: '2.0', id, result: await callSigmaLibraryTool(method, params) };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method_not_found:${method}` } };
}

export function createSigmaLibraryMcpServer() {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return json(res, 200, {
          ok: true,
          service: 'sigma-library-mcp',
          mode: 'read_only',
          toolCount: SIGMA_LIBRARY_MCP_TOOLS.length,
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

export async function startServer({ port = null, host = DEFAULT_HOST } = {}) {
  const server = createSigmaLibraryMcpServer();
  const listenPort = Number(port ?? argValue('--port', process.env.SIGMA_LIBRARY_MCP_PORT || DEFAULT_PORT));
  await new Promise((resolve) => server.listen(listenPort, host, resolve));
  const address = server.address();
  return { server, port: address.port, host };
}

async function main() {
  const { port, host } = await startServer();
  console.log(JSON.stringify({ ok: true, service: 'sigma-library-mcp', host, port, mode: 'read_only' }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`sigma-library-mcp failed: ${error?.message || error}`);
    process.exit(1);
  });
}
