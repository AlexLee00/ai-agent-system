#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { query, run } from '../shared/db.ts';

const CONFIRM = 'luna-active-refresh-stale-close';

function hasArg(name, argv = process.argv.slice(2)) {
  return argv.includes(`--${name}`);
}

function argValue(name, fallback = null, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function parseJsonish(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function statusCount(stats = {}, status = '') {
  return Number(stats?.[status] || 0);
}

export function classifyStaleActiveRefreshSession(row = {}, nodeStats = {}) {
  const runningNodes = statusCount(nodeStats, 'running');
  const failedNodes = statusCount(nodeStats, 'failed');
  const totalNodes = Object.values(nodeStats || {}).reduce((sum, value) => sum + Number(value || 0), 0);
  if (runningNodes > 0) {
    return {
      sessionId: row.session_id,
      action: 'review_required',
      terminalStatus: null,
      reason: 'stale_session_has_running_nodes',
      nodeStats,
    };
  }
  if (totalNodes <= 0) {
    return {
      sessionId: row.session_id,
      action: 'review_required',
      terminalStatus: null,
      reason: 'stale_session_has_no_node_runs',
      nodeStats,
    };
  }
  return {
    sessionId: row.session_id,
    action: 'safe_to_close',
    terminalStatus: failedNodes > 0 ? 'failed' : 'completed',
    reason: failedNodes > 0 ? 'stale_session_has_failed_nodes' : 'stale_session_nodes_terminal',
    nodeStats,
  };
}

async function loadCandidates({ staleBeforeMs, limit }) {
  return query(
    `SELECT session_id, market, trigger_type, status, started_at, symbols, meta
       FROM pipeline_runs
      WHERE trigger_type = 'active_candidate_analysis_refresh'
        AND status = 'running'
        AND started_at < ?
      ORDER BY started_at ASC
      LIMIT ?`,
    [staleBeforeMs, limit],
  ).catch(() => []);
}

async function loadNodeStats(sessionId) {
  const rows = await query(
    `SELECT status, COUNT(*)::int AS count
       FROM pipeline_node_runs
      WHERE session_id = ?
      GROUP BY status`,
    [sessionId],
  ).catch(() => []);
  return Object.fromEntries((rows || []).map((row) => [row.status || 'unknown', Number(row.count || 0)]));
}

async function closeSession(row, plan, now) {
  const meta = parseJsonish(row.meta, {});
  const startedAt = Number(row.started_at || 0);
  const finishedAt = now.getTime();
  const durationMs = Number.isFinite(startedAt) && startedAt > 0 ? Math.max(0, finishedAt - startedAt) : null;
  const mergedMeta = {
    ...meta,
    stale_close: {
      closedAt: now.toISOString(),
      operator: 'runtime-luna-active-refresh-stale-close',
      reason: plan.reason,
      nodeStats: plan.nodeStats,
    },
  };
  return run(
    `UPDATE pipeline_runs
        SET status = ?, finished_at = ?, duration_ms = ?, meta = ?
      WHERE session_id = ?
        AND status = 'running'
        AND trigger_type = 'active_candidate_analysis_refresh'`,
    [plan.terminalStatus, finishedAt, durationMs, JSON.stringify(mergedMeta), row.session_id],
  );
}

export async function runLunaActiveRefreshStaleClose({
  staleMinutes = 30,
  limit = 100,
  apply = false,
  confirm = null,
  now = new Date(),
} = {}) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit || 100)));
  const staleBeforeMs = now.getTime() - Math.max(1, Number(staleMinutes || 30)) * 60 * 1000;
  const candidates = await loadCandidates({ staleBeforeMs, limit: safeLimit });
  const plans = [];
  for (const row of candidates || []) {
    const nodeStats = await loadNodeStats(row.session_id);
    plans.push({
      row: {
        sessionId: row.session_id,
        market: row.market,
        startedAt: row.started_at,
        symbols: row.symbols,
      },
      plan: classifyStaleActiveRefreshSession(row, nodeStats),
    });
  }

  const safePlans = plans.filter((item) => item.plan.action === 'safe_to_close');
  const reviewPlans = plans.filter((item) => item.plan.action !== 'safe_to_close');
  const result = {
    ok: true,
    status: apply ? 'luna_active_refresh_stale_close_apply_ready' : 'luna_active_refresh_stale_close_dry_run',
    generatedAt: now.toISOString(),
    dryRun: !apply,
    applied: false,
    confirmRequired: apply && confirm !== CONFIRM ? CONFIRM : null,
    staleMinutes: Math.max(1, Number(staleMinutes || 30)),
    counts: {
      candidates: plans.length,
      safeToClose: safePlans.length,
      reviewRequired: reviewPlans.length,
      applied: 0,
    },
    safeToClose: safePlans,
    reviewRequired: reviewPlans,
  };

  if (!apply) {
    result.applyCommand = `node scripts/runtime-luna-active-refresh-stale-close.ts --apply --confirm=${CONFIRM} --json`;
    return result;
  }
  if (confirm !== CONFIRM) {
    return {
      ...result,
      ok: false,
      status: 'luna_active_refresh_stale_close_confirm_required',
    };
  }

  let applied = 0;
  for (const item of safePlans) {
    const updateResult = await closeSession(
      {
        session_id: item.row.sessionId,
        started_at: item.row.startedAt,
        meta: candidates.find((row) => row.session_id === item.row.sessionId)?.meta || {},
      },
      item.plan,
      now,
    );
    applied += Number(updateResult?.rowCount || updateResult?.changes || 0) > 0 ? 1 : 0;
  }

  return {
    ...result,
    status: 'luna_active_refresh_stale_close_applied',
    applied: true,
    counts: {
      ...result.counts,
      applied,
    },
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const result = await runLunaActiveRefreshStaleClose({
    staleMinutes: Math.max(1, Number(argValue('stale-minutes', 30, argv)) || 30),
    limit: Math.max(1, Number(argValue('limit', 100, argv)) || 100),
    apply: hasArg('apply', argv),
    confirm: argValue('confirm', null, argv),
  });
  if (hasArg('json', argv)) console.log(JSON.stringify(result, null, 2));
  else console.log(`runtime-luna-active-refresh-stale-close ${result.status}`);
  if (!result.ok) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-luna-active-refresh-stale-close 실패:',
  });
}
