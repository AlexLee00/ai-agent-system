#!/usr/bin/env node
// @ts-nocheck
'use strict';

const pgPool = require('../../../packages/core/lib/pg-pool');

const DEFAULT_START = '2026-07-01';
const DEFAULT_WINDOW_MINUTES = 90;
const META_REPAIR_WINDOW_MINUTES = 40;

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    start: DEFAULT_START,
    windowMinutes: DEFAULT_WINDOW_MINUTES,
    limit: 200,
    json: false,
    apply: false,
    metaRepairOnly: false,
  };
  for (const arg of argv) {
    if (arg === '--json') args.json = true;
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--meta-repair-only') args.metaRepairOnly = true;
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

async function loadMetaRepairTargetPosts(args) {
  return pgPool.queryReadonly('blog', `
    SELECT id, title, post_type, category, status, publish_date, created_at, metadata
    FROM blog.posts
    WHERE metadata->>'writer_model' = 'anthropic_sonnet'
      AND created_at > $1::timestamptz
      AND metadata->>'fallback_used' = 'true'
    ORDER BY created_at ASC
    LIMIT $2
  `, [args.start, args.limit]);
}

async function loadMetaRepairExclusionCounts(args) {
  const rows = await pgPool.queryReadonly('blog', `
    SELECT
      COUNT(*) FILTER (
        WHERE metadata->>'writer_model' = 'anthropic_sonnet'
          AND created_at > $1::timestamptz
          AND COALESCE(metadata->>'fallback_used', 'false') <> 'true'
      )::int AS fallback_false_since_start,
      COUNT(*) FILTER (
        WHERE metadata->>'writer_model' = 'anthropic_sonnet'
          AND created_at <= $1::timestamptz
          AND metadata->>'fallback_used' = 'true'
      )::int AS before_start_fallback_true
    FROM blog.posts
  `, [args.start]);
  return rows[0] || { fallback_false_since_start: 0, before_start_fallback_true: 0 };
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

function selectedRouteForLog(log) {
  return log.selected_route || [log.provider, log.abstract_model].filter(Boolean).join('/') || null;
}

function logIdentity(log) {
  if (log.request_id) return `request:${log.request_id}`;
  return [
    log.created_at ? new Date(log.created_at).toISOString() : '',
    log.provider || '',
    log.agent || '',
    log.selector_key || '',
    log.runtime_purpose || '',
    selectedRouteForLog(log) || '',
  ].join('|');
}

async function loadChunkedRequestLogsForTargets(posts) {
  if (!posts.length) return [];
  const windows = posts.map((post) => ({
    post_id: post.id,
    from: new Date(timeMs(post.created_at) - META_REPAIR_WINDOW_MINUTES * 60_000).toISOString(),
    to: new Date(timeMs(post.created_at)).toISOString(),
  }));
  return pgPool.queryReadonly('hub', `
    WITH target_windows AS (
      SELECT *
      FROM jsonb_to_recordset($1::jsonb) AS w(post_id int, "from" timestamptz, "to" timestamptz)
    )
    SELECT
      w.post_id,
      l.created_at,
      l.provider,
      l.agent,
      l.caller_team,
      l.abstract_model,
      l.selected_route,
      l.fallback_count,
      l.selector_key,
      l.runtime_purpose,
      l.request_id
    FROM target_windows w
    JOIN hub.llm_request_log l
      ON l.created_at >= w."from"
     AND l.created_at <= w."to"
    WHERE l.caller_team = 'blog'
      AND l.runtime_purpose ILIKE '%chunked%'
    ORDER BY w.post_id ASC, l.created_at ASC
  `, [JSON.stringify(windows)]);
}

async function loadMetaRepairNeighborPosts(targets) {
  if (!targets.length) return [];
  const times = targets.map((post) => timeMs(post.created_at)).filter(Boolean);
  if (!times.length) return [];
  const minTime = Math.min(...times) - META_REPAIR_WINDOW_MINUTES * 60_000;
  const maxTime = Math.max(...times);
  return pgPool.queryReadonly('blog', `
    SELECT id, created_at
    FROM blog.posts
    WHERE created_at >= $1::timestamptz
      AND created_at <= $2::timestamptz
    ORDER BY created_at ASC
  `, [
    new Date(minTime).toISOString(),
    new Date(maxTime).toISOString(),
  ]);
}

function assignChunkedLogsToNearestPost(allPosts, logs) {
  const postTimes = allPosts
    .map((post) => ({ id: Number(post.id), timeMs: timeMs(post.created_at) }))
    .filter((post) => Number.isFinite(post.id) && post.timeMs > 0);
  const grouped = new Map();
  for (const log of logs) {
    const key = logIdentity(log);
    const group = grouped.get(key) || [];
    group.push(log);
    grouped.set(key, group);
  }

  const assigned = [];
  for (const group of grouped.values()) {
    const logTime = timeMs(group[0]?.created_at);
    if (!logTime) continue;

    let nearest = null;
    let tied = false;
    for (const post of postTimes) {
      const deltaMs = Math.abs(post.timeMs - logTime);
      if (!nearest || deltaMs < nearest.deltaMs) {
        nearest = { id: post.id, deltaMs };
        tied = false;
      } else if (deltaMs === nearest.deltaMs) {
        tied = true;
      }
    }
    if (!nearest || tied) continue;

    const matchedTargetLog = group.find((log) => Number(log.post_id) === nearest.id);
    if (matchedTargetLog) assigned.push(matchedTargetLog);
  }
  return assigned;
}

function buildMetaRepairCandidate(post, logs) {
  const metadata = safeJson(post.metadata, {});
  const bodyLogs = logs.filter((log) => Number(log.post_id) === Number(post.id));
  const routes = [...new Set(bodyLogs.map(selectedRouteForLog).filter(Boolean))];
  const bodyServedModel = routes.length > 1 ? `chunked:${routes.join('+')}` : (routes[0] || null);
  const bodyFallbackCount = bodyLogs.reduce((sum, log) => sum + Number(log.fallback_count || 0), 0);
  const canRepair = bodyLogs.length > 0 && bodyFallbackCount === 0 && !!bodyServedModel;
  const before = {
    served_model: metadata.served_model || null,
    fallback_used: metadata.fallback_used === true || metadata.fallback_used === 'true',
    repair_used: metadata.repair_used ?? null,
    repair_fallback: metadata.repair_fallback ?? null,
    repair_served_model: metadata.repair_served_model || null,
  };
  const after = canRepair
    ? {
      served_model: bodyServedModel,
      fallback_used: false,
      repair_used: true,
      repair_fallback: true,
      repair_served_model: before.served_model,
    }
    : null;
  return {
    id: post.id,
    title: post.title,
    created_at: post.created_at,
    status: post.status,
    before,
    after,
    dry_run_only: true,
    repairable: canRepair,
    reason: canRepair ? 'body_chunked_logs_have_zero_fallbacks' : 'missing_body_chunked_logs_or_body_fallback_detected',
    evidence: {
      window_minutes: META_REPAIR_WINDOW_MINUTES,
      body_log_count: bodyLogs.length,
      body_fallback_count: bodyFallbackCount,
      body_routes: routes,
      body_logs: bodyLogs.map((log) => ({
        created_at: log.created_at,
        provider: log.provider || null,
        selected_route: log.selected_route || null,
        fallback_count: Number(log.fallback_count || 0),
        selector_key: log.selector_key || null,
        runtime_purpose: log.runtime_purpose || null,
        request_id: log.request_id || null,
      })),
    },
  };
}

async function buildMetaRepairDryRun(args) {
  const [targets, exclusionCounts] = await Promise.all([
    loadMetaRepairTargetPosts(args),
    loadMetaRepairExclusionCounts(args),
  ]);
  const [rawLogs, neighborPosts] = await Promise.all([
    loadChunkedRequestLogsForTargets(targets),
    loadMetaRepairNeighborPosts(targets),
  ]);
  const logs = assignChunkedLogsToNearestPost(neighborPosts, rawLogs);
  const candidates = targets.map((post) => buildMetaRepairCandidate(post, logs));
  return {
    ok: true,
    applied: false,
    apply_disabled: true,
    start: args.start,
    targetPredicate: "metadata.writer_model='anthropic_sonnet' AND created_at > start AND metadata.fallback_used='true'",
    targetCount: targets.length,
    repairableCount: candidates.filter((item) => item.repairable).length,
    rawBodyLogCount: rawLogs.length,
    assignedBodyLogCount: logs.length,
    exclusionCounts,
    candidates,
  };
}

async function runBackfillDry(args = parseArgs()) {
  if (args.apply) {
    return {
      ok: false,
      applied: false,
      error: 'apply_disabled_pending_meti_review',
    };
  }
  const [posts, logs, metaRepair] = await Promise.all([
    loadPosts(args),
    loadRoutingLogs(args),
    buildMetaRepairDryRun(args),
  ]);
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
    metaRepair,
  };
}

async function main() {
  const args = parseArgs();
  if (args.metaRepairOnly) {
    if (args.apply) {
      console.log(JSON.stringify({
        ok: false,
        applied: false,
        error: 'apply_disabled_pending_meti_review',
      }, null, 2));
      process.exit(2);
    }
    const metaRepair = await buildMetaRepairDryRun(args);
    console.log(JSON.stringify(metaRepair, null, 2));
    process.exit(metaRepair.ok ? 0 : 2);
  }
  const result = await runBackfillDry(args);
  if (args.json || result.ok === false) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[blog-ab-provider-backfill] posts=${result.posts} matched=${result.matched} polluted_posts=${result.pollutedCount} polluted_logs=${result.pollutedRoutingLogCount}`);
    console.log(`[blog-ab-meta-repair] targets=${result.metaRepair.targetCount} repairable=${result.metaRepair.repairableCount} apply_disabled=${result.metaRepair.apply_disabled}`);
    for (const item of result.metaRepair.candidates.slice(0, 20)) {
      const after = item.after || {};
      console.log(`- #${item.id} fb ${item.before.fallback_used} -> ${after.fallback_used} served ${item.before.served_model || 'null'} -> ${after.served_model || 'null'} repairable=${item.repairable} ${item.title}`);
    }
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
  assignChunkedLogsToNearestPost,
  buildMetaRepairCandidate,
  buildMetaRepairDryRun,
  runBackfillDry,
};
