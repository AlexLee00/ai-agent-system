#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pgPool = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool.ts'));
const kst = require(path.join(PROJECT_ROOT, 'packages/core/lib/kst.js'));

const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_WORKSPACE = path.join(os.homedir(), '.ai-agent-system/workspace');
const DEFAULT_SERVICES = [
  { key: 'hub', url: 'http://127.0.0.1:7788/hub/health/live' },
  { key: 'luna_ops_mcp', url: 'http://127.0.0.1:4092/health' },
  { key: 'hub_ops_mcp', url: 'http://127.0.0.1:4095/health' },
  { key: 'sigma_library_mcp', url: 'http://127.0.0.1:4097/health' },
  { key: 'ska_ops_mcp', url: 'http://127.0.0.1:4098/health' },
  { key: 'darwin_ops_mcp', url: 'http://127.0.0.1:4099/health' },
  { key: 'blog_node_server', url: 'http://127.0.0.1:3100/health' },
  { key: 'local_llm', url: 'http://127.0.0.1:11434/v1/models' },
];

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function snapshotPaths(env = process.env) {
  const workspace = env.SESSION_SNAPSHOT_WORKSPACE || DEFAULT_WORKSPACE;
  return {
    markdown: env.SESSION_SNAPSHOT_MARKDOWN || path.join(workspace, 'session-snapshot.md'),
    jsonl: env.SESSION_SNAPSHOT_JSONL || path.join(workspace, 'session-snapshot.jsonl'),
  };
}

function timeoutError(label, timeoutMs) {
  const error = new Error(`${label}_timeout_${timeoutMs}ms`);
  error.code = 'SNAPSHOT_TIMEOUT';
  return error;
}

async function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeoutError(label, timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probeService(service, options = {}) {
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const fetchImpl = options.fetchImpl || fetch;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const fetchOptions = controller ? { signal: controller.signal } : undefined;
  const abortTimer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  const startedAt = Date.now();
  try {
    const response = await withTimeout(fetchImpl(service.url, fetchOptions), timeoutMs, service.key);
    const body = typeof response.text === 'function'
      ? await withTimeout(response.text(), timeoutMs, `${service.key}_body`)
      : '';
    return {
      key: service.key,
      url: service.url,
      ok: Boolean(response.ok),
      status: Number(response.status || 0),
      durationMs: Date.now() - startedAt,
      bodyPreview: String(body || '').slice(0, 160),
    };
  } catch (error) {
    return {
      key: service.key,
      url: service.url,
      ok: false,
      status: 0,
      durationMs: Date.now() - startedAt,
      error: String(error?.message || error).slice(0, 180),
    };
  } finally {
    if (abortTimer) clearTimeout(abortTimer);
  }
}

export async function collectServiceHealth(options = {}) {
  const services = options.services || DEFAULT_SERVICES;
  const results = await Promise.all(services.map((service) => probeService(service, options)));
  return {
    ok: results.every((item) => item.ok),
    checked: results.length,
    failed: results.filter((item) => !item.ok).length,
    services: results,
  };
}

export function summarizeLaunchdList(output = '') {
  const rows = String(output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const parsed = rows.flatMap((line) => {
    const parts = line.split(/\s+/);
    if (parts.length < 3 || parts[0] === 'PID') return [];
    const label = parts.slice(2).join(' ');
    if (!label.startsWith('ai.')) return [];
    const status = Number(parts[1]);
    return [{
      pid: parts[0],
      status: Number.isFinite(status) ? status : null,
      label,
    }];
  });
  const failed = parsed.filter((row) => row.pid === '-' && row.status != null && row.status !== 0);
  const runningWithLastExit = parsed.filter((row) => row.pid !== '-' && row.status != null && row.status !== 0);
  return {
    ok: true,
    checked: parsed.length,
    failedCount: failed.length,
    failed: failed.slice(0, 20),
    runningWithLastExitCount: runningWithLastExit.length,
    runningWithLastExit: runningWithLastExit.slice(0, 20),
  };
}

export async function collectLaunchdFailures(options = {}) {
  if (options.skipLaunchctl) {
    return { ok: true, skipped: true, reason: 'skip_launchctl_requested', checked: 0, failedCount: 0, failed: [] };
  }
  try {
    const result = options.launchctlOutput != null
      ? { stdout: options.launchctlOutput }
      : await execFileAsync('/bin/launchctl', ['list'], { timeout: Number(options.timeoutMs || 3000), maxBuffer: 2 * 1024 * 1024 });
    return summarizeLaunchdList(result.stdout || '');
  } catch (error) {
    return {
      ok: false,
      checked: 0,
      failedCount: 0,
      failed: [],
      error: String(error?.message || error).slice(0, 180),
    };
  }
}

export function summarizeOpsConsoleServeStatus(output = '') {
  try {
    const parsed = typeof output === 'string' ? JSON.parse(output || '{}') : output;
    const web = parsed?.Web && typeof parsed.Web === 'object' ? parsed.Web : {};
    const has8444WebMapping = Object.entries(web).some(([host, value]) => {
      const handlers = value?.Handlers && typeof value.Handlers === 'object' ? value.Handlers : {};
      return String(host).includes(':8444') && Object.keys(handlers).length > 0;
    });
    return has8444WebMapping ? 'ok' : 'missing';
  } catch {
    return String(output || '').includes(':8444') ? 'ok' : 'missing';
  }
}

export async function collectOpsConsoleServeStatus(options = {}) {
  if (options.tailscaleServeStatusOutput != null) {
    return summarizeOpsConsoleServeStatus(options.tailscaleServeStatusOutput);
  }
  try {
    const result = await execFileAsync('tailscale', ['serve', 'status', '--json'], {
      timeout: Number(options.timeoutMs || 3000),
      maxBuffer: 512 * 1024,
    });
    return summarizeOpsConsoleServeStatus(result.stdout || '');
  } catch {
    return 'missing';
  }
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readLatestJsonl(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        return JSON.parse(lines[i]);
      } catch {
        // Continue scanning older lines.
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function safeMetric(key, fn) {
  try {
    const value = await withTimeout(Promise.resolve(fn()), 4000, key);
    return { ok: true, ...value };
  } catch (error) {
    return { ok: false, skipped: true, error: String(error?.message || error).slice(0, 180) };
  }
}

export async function collectCoreMetrics(options = {}) {
  const queryReadonly = options.queryReadonly || pgPool.queryReadonly;
  const workspace = options.workspace || DEFAULT_WORKSPACE;
  const sigmaTransition = readLatestJsonl(path.join(workspace, 'sigma', 'transition-telemetry.jsonl'));

  const [skaReservations, chainRequired, weakSymbol, sonnetTags, darwinShadow] = await Promise.all([
    safeMetric('ska_today_reservations', async () => {
      const rows = await queryReadonly('reservation', `
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE LOWER(COALESCE(status::text, '')) = 'cancelled')::int AS cancelled,
          COUNT(*) FILTER (WHERE LOWER(COALESCE(status::text, '')) = 'completed')::int AS completed
        FROM reservation.reservations
        WHERE (
          CASE
            WHEN NULLIF(date::text, '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
            THEN NULLIF(date::text, '')::date
            ELSE NULL
          END
        ) = CURRENT_DATE
      `, []);
      return { rows: rows[0] || { total: 0, cancelled: 0, completed: 0 } };
    }),
    safeMetric('hub_chain_required_24h', async () => {
      const rows = await queryReadonly('public', `
        SELECT COUNT(*)::int AS count
        FROM public.llm_routing_log
        WHERE created_at >= NOW() - INTERVAL '24 hours'
          AND COALESCE(error, '') ILIKE '%llm_selector_chain_required%'
      `, []);
      return { count: Number(rows[0]?.count || 0) };
    }),
    safeMetric('luna_weak_symbol_24h', async () => {
      const rows = await queryReadonly('investment', `
        SELECT COUNT(*)::int AS count
        FROM investment.guard_events
        WHERE triggered_at >= NOW() - INTERVAL '24 hours'
          AND guard_name = 'weak_symbol_quality_hard'
      `, []);
      return { count: Number(rows[0]?.count || 0) };
    }),
    safeMetric('blog_sonnet_tags_24h', async () => {
      const rows = await queryReadonly('blog', `
        SELECT
          COUNT(*) FILTER (WHERE metadata->>'writer_model' IS NOT NULL)::int AS tagged,
          COUNT(*) FILTER (WHERE metadata->>'writer_model' = 'anthropic_sonnet')::int AS sonnet,
          COUNT(*) FILTER (WHERE metadata->>'fallback_used' = 'true')::int AS fallback
        FROM blog.posts
        WHERE created_at >= NOW() - INTERVAL '24 hours'
      `, []);
      return { rows: rows[0] || { tagged: 0, sonnet: 0, fallback: 0 } };
    }),
    safeMetric('darwin_shadow', async () => {
      const store = require(path.join(PROJECT_ROOT, 'bots/darwin/lib/proposal-store.ts'));
      const proposals = store.listProposals();
      const counts = {};
      for (const proposal of proposals) {
        const state = store.normalizeProposalState(proposal.status);
        counts[state] = (counts[state] || 0) + 1;
      }
      return { total: proposals.length, counts };
    }),
  ]);

  return {
    ska: {
      todayReservations: skaReservations,
    },
    sigma: {
      transition: sigmaTransition
        ? {
            type: sigmaTransition.type,
            dryRun: sigmaTransition.dryRun,
            transitionEnabled: sigmaTransition.transitionEnabled,
            counts: sigmaTransition.counts || {},
          }
        : { ok: false, skipped: true, reason: 'transition_telemetry_missing' },
    },
    hub: { chainRequired24h: chainRequired },
    luna: { weakSymbolHard24h: weakSymbol },
    blog: { sonnetTags24h: sonnetTags },
    darwin: { shadow: darwinShadow },
  };
}

export function renderSnapshotMarkdown(snapshot) {
  const serviceLines = snapshot.health.services.map((item) =>
    `| ${item.key} | ${item.ok ? 'OK' : 'FAIL'} | ${item.status || '-'} | ${item.durationMs} | ${item.error || ''} |`);
  const failedLaunchd = snapshot.launchd.failed || [];
  const runningWithLastExit = snapshot.launchd.runningWithLastExit || [];
  const metric = snapshot.metrics;
  return [
    '# Team Jay Session Snapshot',
    '',
    `- Generated: ${snapshot.generatedAtKst}`,
    `- Duration: ${snapshot.durationMs}ms`,
    `- Overall: ${snapshot.ok ? 'OK' : 'CHECK'}`,
    '',
    '## Service Health',
    '',
    '| Service | Result | HTTP | ms | Error |',
    '|---|---:|---:|---:|---|',
    ...serviceLines,
    '',
    '## Launchd',
    '',
    `- Checked ai.* jobs: ${snapshot.launchd.checked || 0}`,
    `- Failed jobs: ${snapshot.launchd.failedCount || 0}`,
    ...(failedLaunchd.length ? failedLaunchd.map((row) => `  - ${row.label}: status=${row.status}`) : ['  - none']),
    `- Running jobs with stale nonzero last exit: ${snapshot.launchd.runningWithLastExitCount || 0}`,
    ...(runningWithLastExit.length ? runningWithLastExit.map((row) => `  - ${row.label}: last_status=${row.status}`) : ['  - none']),
    '',
    '## Core Signals',
    '',
    `- SKA today reservations: ${JSON.stringify(metric.ska.todayReservations.rows || metric.ska.todayReservations)}`,
    `- Sigma transition: ${JSON.stringify(metric.sigma.transition)}`,
    `- Hub chain_required 24h: ${JSON.stringify(metric.hub.chainRequired24h)}`,
    `- Luna weak symbol hard 24h: ${JSON.stringify(metric.luna.weakSymbolHard24h)}`,
    `- Blog sonnet tags 24h: ${JSON.stringify(metric.blog.sonnetTags24h.rows || metric.blog.sonnetTags24h)}`,
    `- Darwin shadow: ${JSON.stringify(metric.darwin.shadow)}`,
    `- OPS Console serve :8444: ${snapshot.opsConsoleServe}`,
    '',
  ].join('\n');
}

export function sessionSnapshotOk({ health, launchd, opsConsoleServe }) {
  return Boolean(
    health?.failed === 0
      && launchd?.ok !== false
      && (launchd?.failedCount || 0) === 0
      && opsConsoleServe === 'ok',
  );
}

export async function buildSessionSnapshot(options = {}) {
  const startedAt = Date.now();
  const generatedAt = new Date();
  const [health, launchd, metrics, opsConsoleServe] = await Promise.all([
    collectServiceHealth(options),
    collectLaunchdFailures(options),
    collectCoreMetrics(options),
    collectOpsConsoleServeStatus(options),
  ]);
  const snapshot = {
    ok: sessionSnapshotOk({ health, launchd, opsConsoleServe }),
    source: 'jay_session_snapshot',
    generatedAt: generatedAt.toISOString(),
    generatedAtKst: kst.datetimeStr(),
    durationMs: Date.now() - startedAt,
    opsConsoleServe,
    health,
    launchd,
    metrics,
    safety: {
      readOnly: true,
      launchctlMutation: false,
      dbWrite: false,
      protectedRestart: false,
    },
  };
  snapshot.markdown = renderSnapshotMarkdown(snapshot);
  return snapshot;
}

export function writeSnapshot(snapshot, options = {}) {
  const paths = snapshotPaths(options.env || process.env);
  for (const [key, value] of Object.entries(options.paths || {})) {
    if (value) paths[key] = value;
  }
  fs.mkdirSync(path.dirname(paths.markdown), { recursive: true });
  fs.writeFileSync(paths.markdown, snapshot.markdown, 'utf8');
  fs.mkdirSync(path.dirname(paths.jsonl), { recursive: true });
  fs.appendFileSync(paths.jsonl, `${JSON.stringify({ ...snapshot, markdown: undefined })}\n`, 'utf8');
  return paths;
}

export async function runSessionSnapshot(options = {}) {
  const snapshot = await buildSessionSnapshot(options);
  const paths = options.write === false ? null : writeSnapshot(snapshot, options);
  return { ...snapshot, paths };
}

async function main() {
  const result = await runSessionSnapshot({
    write: !hasFlag('no-write'),
    skipLaunchctl: hasFlag('no-launchctl'),
    paths: {
      markdown: argValue('--out', null) || undefined,
      jsonl: argValue('--jsonl', null) || undefined,
    },
  });
  if (hasFlag('json')) console.log(JSON.stringify({ ...result, markdown: undefined }, null, 2));
  else console.log(result.markdown);
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2));
    process.exitCode = 1;
  });
}

export default {
  buildSessionSnapshot,
  collectCoreMetrics,
  collectLaunchdFailures,
  collectOpsConsoleServeStatus,
  collectServiceHealth,
  renderSnapshotMarkdown,
  runSessionSnapshot,
  sessionSnapshotOk,
  summarizeOpsConsoleServeStatus,
  summarizeLaunchdList,
  writeSnapshot,
};
