#!/usr/bin/env node
// @ts-nocheck
'use strict';

const pgPool = require('../../../packages/core/lib/pg-pool');

const DEFAULT_START = '2026-07-06';
const DEFAULT_WINDOW_MINUTES = 90;

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    start: DEFAULT_START,
    windowMinutes: DEFAULT_WINDOW_MINUTES,
    limit: 200,
    json: false,
    apply: false,
  };
  for (const arg of argv) {
    if (arg === '--json') args.json = true;
    else if (arg === '--apply') args.apply = true;
    else if (arg.startsWith('--start=')) args.start = arg.slice('--start='.length);
    else if (arg.startsWith('--window-minutes=')) args.windowMinutes = Math.max(1, Number(arg.slice('--window-minutes='.length)) || DEFAULT_WINDOW_MINUTES);
    else if (arg.startsWith('--limit=')) args.limit = Math.max(1, Number(arg.slice('--limit='.length)) || 200);
  }
  return args;
}

function safeJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); } catch { return fallback; }
}

function routeFamily(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (text.startsWith('claude-code/') || text.includes('claude') || text.includes('anthropic')) return 'anthropic';
  if (text.startsWith('openai') || text.includes('/gpt') || text.includes('gpt-')) return 'openai';
  if (text.startsWith('gemini') || text.includes('gemini')) return 'gemini';
  if (text.startsWith('groq') || text.includes('llama')) return 'groq';
  if (text.startsWith('local')) return 'local';
  return '';
}

function selectorForPost(post) {
  return String(post?.post_type || '').toLowerCase() === 'lecture'
    ? 'blog.pos.writer'
    : 'blog.gems.writer';
}

function timeMs(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function estimateProviderForPost(post, logs, options = {}) {
  const windowMs = Math.max(1, Number(options.windowMinutes || DEFAULT_WINDOW_MINUTES)) * 60_000;
  const postTime = timeMs(post.created_at || post.publish_date);
  const metadata = safeJson(post.metadata, {});
  const traceId = String(metadata.trace_id || '').trim();
  const expectedSelector = selectorForPost(post);
  const candidates = [];

  for (const log of logs) {
    const logTime = timeMs(log.created_at);
    const deltaMs = Math.abs(logTime - postTime);
    const traceMatch = traceId && traceId === String(log.trace_id || '').trim();
    const selectorMatch = String(log.selector_key || '') === expectedSelector;
    const agentMatch = expectedSelector.includes('.pos.')
      ? String(log.agent || '').toLowerCase() === 'pos'
      : String(log.agent || '').toLowerCase() === 'gems';
    if (!traceMatch && deltaMs > windowMs) continue;
    if (!traceMatch && !selectorMatch && !agentMatch) continue;

    candidates.push({
      log,
      deltaMs,
      score: (traceMatch ? 1_000_000 : 0) + (selectorMatch ? 10_000 : 0) + (agentMatch ? 2_000 : 0) - deltaMs,
      traceMatch,
      selectorMatch,
      agentMatch,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0] || null;
  if (!best) {
    return {
      post_id: post.id,
      title: post.title,
      matched: false,
      confidence: 'none',
      reason: 'no_routing_log_match',
    };
  }

  const log = best.log;
  const requestedModel = metadata.writer_model || log.abstract_model || null;
  const servedModel = log.selected_route || [log.provider, log.abstract_model].filter(Boolean).join('/') || null;
  const fallbackCount = Number(log.fallback_count || 0);
  const requestedFamily = routeFamily(requestedModel);
  const servedFamily = routeFamily(servedModel || log.provider);
  const polluted = fallbackCount > 0 && requestedFamily && servedFamily && requestedFamily !== servedFamily;

  return {
    post_id: post.id,
    title: post.title,
    post_type: post.post_type,
    created_at: post.created_at,
    matched: true,
    confidence: best.traceMatch ? 'trace' : best.deltaMs <= 15 * 60_000 ? 'high' : 'time_window',
    delta_seconds: Math.round(best.deltaMs / 1000),
    requested_model: requestedModel,
    served_model: servedModel,
    provider: log.provider || null,
    fallback_count: fallbackCount,
    trace_id: log.trace_id || metadata.trace_id || null,
    selector_key: log.selector_key || null,
    polluted,
  };
}

function summarizePollutedRoutingLogs(logs) {
  const seen = new Set();
  const polluted = [];
  for (const log of logs) {
    const requestedModel = log.abstract_model || null;
    const servedModel = log.selected_route || [log.provider, log.abstract_model].filter(Boolean).join('/') || null;
    const fallbackCount = Number(log.fallback_count || 0);
    const requestedFamily = routeFamily(requestedModel);
    const servedFamily = routeFamily(servedModel || log.provider);
    const isPolluted = fallbackCount > 0 && requestedFamily && servedFamily && requestedFamily !== servedFamily;
    if (!isPolluted) continue;
    const key = [
      log.created_at ? new Date(log.created_at).toISOString() : '',
      log.agent || '',
      requestedModel || '',
      servedModel || '',
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    polluted.push({
      created_at: log.created_at,
      agent: log.agent || null,
      selector_key: log.selector_key || null,
      requested_model: requestedModel,
      served_model: servedModel,
      provider: log.provider || null,
      fallback_count: fallbackCount,
      trace_id: log.trace_id || null,
    });
  }
  return polluted;
}

async function tableColumns(schema, table) {
  const rows = await pgPool.queryReadonly('public', `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = $1
      AND table_name = $2
  `, [schema, table]);
  return new Set(rows.map((row) => row.column_name));
}

async function loadPosts(args) {
  return pgPool.queryReadonly('blog', `
    SELECT id, title, post_type, category, status, publish_date, created_at, metadata
    FROM blog.posts
    WHERE created_at >= $1::timestamptz
    ORDER BY created_at ASC
    LIMIT $2
  `, [args.start, args.limit]);
}

async function loadRoutingLogs(args) {
  const columns = await tableColumns('public', 'llm_routing_log');
  const optional = ['trace_id', 'selector_key', 'selected_route', 'runtime_purpose']
    .filter((column) => columns.has(column))
    .join(', ');
  const selectOptional = optional ? `, ${optional}` : '';
  const filters = [];
  if (columns.has('selector_key')) filters.push(`selector_key IN ('blog.gems.writer', 'blog.pos.writer')`);
  if (columns.has('runtime_purpose')) filters.push(`runtime_purpose ILIKE '%writer%'`);
  filters.push(`agent IN ('gems', 'pos')`);

  return pgPool.queryReadonly('public', `
    SELECT created_at, provider, agent, caller_team, abstract_model, fallback_count${selectOptional}
    FROM public.llm_routing_log
    WHERE caller_team = 'blog'
      AND created_at >= $1::timestamptz - interval '2 hours'
      AND (${filters.join(' OR ')})
    ORDER BY created_at ASC
    LIMIT $2
  `, [args.start, Math.max(args.limit * 12, 500)]);
}

async function runBackfillDry(args = parseArgs()) {
  if (args.apply) {
    return {
      ok: false,
      applied: false,
      error: 'apply_disabled_pending_meti_review',
    };
  }
  const [posts, logs] = await Promise.all([loadPosts(args), loadRoutingLogs(args)]);
  const estimates = posts.map((post) => estimateProviderForPost(post, logs, args));
  const polluted = estimates.filter((item) => item.polluted);
  const pollutedRoutingLogs = summarizePollutedRoutingLogs(logs);
  return {
    ok: true,
    applied: false,
    start: args.start,
    windowMinutes: args.windowMinutes,
    posts: posts.length,
    routingLogs: logs.length,
    matched: estimates.filter((item) => item.matched).length,
    pollutedCount: polluted.length,
    pollutedRoutingLogCount: pollutedRoutingLogs.length,
    polluted,
    pollutedRoutingLogs,
    estimates,
  };
}

async function main() {
  const args = parseArgs();
  const result = await runBackfillDry(args);
  if (args.json || result.ok === false) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[blog-ab-provider-backfill] posts=${result.posts} matched=${result.matched} polluted_posts=${result.pollutedCount} polluted_logs=${result.pollutedRoutingLogCount}`);
    for (const item of result.polluted.slice(0, 20)) {
      console.log(`- #${item.post_id} ${item.requested_model} -> ${item.served_model} fallback=${item.fallback_count} ${item.title}`);
    }
  }
  process.exit(result.ok ? 0 : 2);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  routeFamily,
  estimateProviderForPost,
  summarizePollutedRoutingLogs,
  runBackfillDry,
};
