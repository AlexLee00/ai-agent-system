#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildSessionSnapshot } from '../../../../scripts/runtime-session-snapshot.ts';
import { classifyOpsPushEvent } from '../../lib/ops-push-router.ts';

const require = createRequire(import.meta.url);
const pgPool = require('../../../../packages/core/lib/pg-pool.ts');

const SERVICE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(SERVICE_ROOT, 'web');
const PROJECT_ROOT = path.resolve(SERVICE_ROOT, '../../../..');
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4090;
const DEFAULT_TOWN_LIMIT = 50;
const TOWN_POLL_MS = 10_000;
const DEFAULT_BRIDGE_ROOT = path.join(os.homedir(), '.ai-agent-system/workspace/bridge');
const DEFAULT_PUSH_SUBSCRIPTIONS_PATH = path.join(os.homedir(), '.ai-agent-system/state/ops-console/push-subscriptions.json');
const STATIC_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
});

const TEAM_META = Object.freeze({
  hub: { name: '허브', emoji: '🧭', color: '#7DD3FC' },
  ska: { name: '스카', emoji: '🍀', color: '#86EFAC' },
  luna: { name: '루나', emoji: '🐺', color: '#F9A8D4' },
  claude: { name: '클로드', emoji: '🤖', color: '#C4B5FD' },
  blog: { name: '블로', emoji: '🐦', color: '#FDBA74' },
  sigma: { name: '시그마', emoji: '🦉', color: '#FDE68A' },
  darwin: { name: '다윈', emoji: '🧬', color: '#6EE7B7' },
  orchestrator: { name: '오케스트라', emoji: '🎼', color: '#A5B4FC' },
  write: { name: '라이트', emoji: '✍️', color: '#D6D3D1' },
});

function nowIso() {
  return new Date().toISOString();
}

function json(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...STATIC_HEADERS,
    ...extraHeaders,
  });
  res.end(body);
}

function text(res, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    ...STATIC_HEADERS,
  });
  res.end(body);
}

function safeJson(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function compactText(parts, max = 180) {
  return parts
    .flatMap((part) => {
      if (part == null || part === '') return [];
      if (typeof part === 'string') return [part];
      return [JSON.stringify(part)];
    })
    .join(' · ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function toIso(value) {
  if (!value) return nowIso();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : nowIso();
}

function normalizeTeam(team) {
  const raw = String(team || '').toLowerCase().trim();
  if (raw.includes('luna') || raw === 'investment') return 'luna';
  if (raw.includes('blog')) return 'blog';
  if (raw.includes('claude') || raw.includes('codex')) return 'claude';
  if (raw.includes('sigma')) return 'sigma';
  if (raw.includes('darwin') || raw.includes('research')) return 'darwin';
  if (raw.includes('ska') || raw.includes('reservation')) return 'ska';
  if (raw.includes('write')) return 'write';
  if (raw.includes('orchestrator') || raw.includes('jay')) return 'orchestrator';
  if (raw.includes('hub')) return 'hub';
  return raw || 'hub';
}

function eventRow({ ts, from, to, text, tag, kind, sourceId = null, accent = false }) {
  const fromTeam = normalizeTeam(from);
  const toTeam = normalizeTeam(to || fromTeam);
  return {
    ts: toIso(ts),
    from: fromTeam,
    to: toTeam,
    text: compactText([text], 220) || `${fromTeam} activity`,
    tag: String(tag || kind || 'activity').slice(0, 64),
    kind: String(kind || 'activity').slice(0, 64),
    sourceId,
    accent: Boolean(accent || kind === 'transition' || kind === 'bridge'),
  };
}

async function safeQuery(schema, label, sql, params = [], queryReadonly = pgPool.queryReadonly) {
  try {
    return await queryReadonly(schema, sql, params);
  } catch (error) {
    return [{
      __opsConsoleError: true,
      label,
      error: String(error?.message || error).slice(0, 180),
      created_at: nowIso(),
    }];
  }
}

function readLatestJsonlEvents(filePath, limit = 20) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines.slice(-limit).flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function readBridgeReportEvents(limit = 20) {
  const dirs = [
    path.join(process.env.HOME || '', '.ai-agent-system/workspace/bridge/outbox'),
    path.join(process.env.HOME || '', '.ai-agent-system/workspace/bridge/archive'),
  ];
  const files = dirs.flatMap((dir) => {
    try {
      return fs.readdirSync(dir)
        .filter((name) => /^REPORT-\d+\.md$/.test(name))
        .map((name) => path.join(dir, name));
    } catch {
      return [];
    }
  });
  return files
    .map((filePath) => {
      const stat = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, 'utf8');
      const title = content.split(/\r?\n/).find((line) => line.trim().startsWith('#')) || path.basename(filePath);
      const status = content.match(/status:\s*([a-z_]+)/i)?.[1] || 'reported';
      return eventRow({
        ts: stat.mtime,
        from: 'bridge',
        to: 'orchestrator',
        text: `${title.replace(/^#+\s*/, '')} · status=${status}`,
        tag: 'bridge',
        kind: 'bridge',
        sourceId: path.basename(filePath),
        accent: true,
      });
    })
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, limit);
}

function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function fileMtime(filePath) {
  try {
    return fs.statSync(filePath).mtime.toISOString();
  } catch {
    return nowIso();
  }
}

function bridgeIdFromName(name) {
  return String(name || '').match(/(?:TASK|REPORT)-(\d+)/)?.[1] || '';
}

function bridgeTitleFromMarkdown(content, fallback) {
  const title = String(content || '').split(/\r?\n/).find((line) => line.trim().startsWith('#'));
  return (title ? title.replace(/^#+\s*/, '').trim() : fallback).slice(0, 180);
}

function parseBridgeReport(content) {
  const status = String(content || '').match(/status:\s*([a-z_]+)/i)?.[1] || '';
  const verdict = String(content || '').match(/verdict:\s*([a-z_]+)/i)?.[1] || '';
  return { status, verdict };
}

function readBridgeVerifyLog(bridgeRoot) {
  const candidates = [
    path.join(bridgeRoot, 'verify-log.jsonl'),
    path.join(bridgeRoot, 'archive', 'verify-log.jsonl'),
  ];
  const verdicts = new Map();
  for (const filePath of candidates) {
    for (const line of readTextFile(filePath).split(/\r?\n/).map((row) => row.trim()).filter(Boolean)) {
      try {
        const parsed = JSON.parse(line);
        const id = String(parsed.taskId || parsed.id || parsed.task_id || '').match(/\d+/)?.[0];
        if (id) verdicts.set(id, parsed);
      } catch {
        // Ignore malformed historic verifier rows.
      }
    }
  }
  return verdicts;
}

export function collectBridgeQueue(options = {}) {
  const bridgeRoot = options.bridgeRoot || DEFAULT_BRIDGE_ROOT;
  const inbox = path.join(bridgeRoot, 'inbox');
  const outbox = path.join(bridgeRoot, 'outbox');
  const archive = path.join(bridgeRoot, 'archive');
  const verifyLog = readBridgeVerifyLog(bridgeRoot);
  const items = new Map();

  function upsert(id, patch) {
    if (!id) return;
    const current = items.get(id) || {
      id,
      title: `TASK-${id}`,
      status: 'unknown',
      verdict: 'pending',
      ts: nowIso(),
    };
    items.set(id, { ...current, ...patch, id });
  }

  function scanTaskDir(dir, status) {
    try {
      for (const name of fs.readdirSync(dir).filter((row) => /^TASK-\d+\.md$/.test(row))) {
        const filePath = path.join(dir, name);
        const id = bridgeIdFromName(name);
        const content = readTextFile(filePath);
        upsert(id, {
          title: bridgeTitleFromMarkdown(content, name),
          status,
          verdict: status === 'pending' ? 'pending' : 'archived',
          ts: fileMtime(filePath),
          taskPath: filePath,
        });
      }
    } catch {
      // Missing bridge folders are represented as an empty queue.
    }
  }

  function scanReportDir(dir, archived = false) {
    try {
      for (const name of fs.readdirSync(dir).filter((row) => /^REPORT-\d+\.md$/.test(row))) {
        const filePath = path.join(dir, name);
        const id = bridgeIdFromName(name);
        const content = readTextFile(filePath);
        const report = parseBridgeReport(content);
        upsert(id, {
          title: bridgeTitleFromMarkdown(content, `REPORT-${id}`),
          status: report.status || (archived ? 'done' : 'reported'),
          verdict: report.verdict || (archived ? 'verified' : 'reported'),
          ts: fileMtime(filePath),
          reportPath: filePath,
        });
      }
    } catch {
      // Missing bridge folders are represented as an empty queue.
    }
  }

  scanTaskDir(inbox, 'pending');
  scanReportDir(outbox, false);
  scanTaskDir(archive, 'archived');
  scanReportDir(archive, true);

  for (const [id, row] of verifyLog.entries()) {
    upsert(id, {
      verdict: row.verdict || row.status || 'verified',
      verifyTs: toIso(row.ts || row.at || row.created_at),
      verifier: row.verifier || row.by || 'bridge-verifier',
    });
  }

  const rows = Array.from(items.values())
    .map((item) => ({
      id: `TASK-${item.id}`,
      title: item.title,
      status: item.status,
      verdict: item.verdict,
      ts: item.verifyTs || item.ts,
      taskPath: item.taskPath || null,
      reportPath: item.reportPath || null,
      verifier: item.verifier || null,
    }))
    .sort((a, b) => b.ts.localeCompare(a.ts));

  return {
    ok: true,
    readOnly: true,
    generatedAt: nowIso(),
    bridgeRoot,
    counts: {
      total: rows.length,
      pending: rows.filter((row) => row.status === 'pending').length,
      done: rows.filter((row) => row.status === 'done' || row.verdict === 'verified').length,
      failed: rows.filter((row) => /fail|reject/i.test(`${row.status} ${row.verdict}`)).length,
    },
    items: rows,
  };
}

function resolvePushConfig(options = {}) {
  const webPush = options.webPush || (() => {
    try {
      return require('web-push');
    } catch {
      return null;
    }
  })();
  const publicKey = String(options.vapidPublicKey || process.env.OPS_CONSOLE_VAPID_PUBLIC_KEY || '');
  const privateKey = String(options.vapidPrivateKey || process.env.OPS_CONSOLE_VAPID_PRIVATE_KEY || '');
  const subject = String(options.vapidSubject || process.env.OPS_CONSOLE_VAPID_SUBJECT || 'mailto:ops-console@localhost');
  const subscriptionPath = options.pushSubscriptionPath || process.env.OPS_CONSOLE_PUSH_SUBSCRIPTIONS_PATH || DEFAULT_PUSH_SUBSCRIPTIONS_PATH;
  const configured = Boolean(webPush && publicKey && privateKey);
  if (configured) webPush.setVapidDetails(subject, publicKey, privateKey);
  return { webPush, publicKey, privateKey, subject, subscriptionPath, configured };
}

function normalizePushSubscription(input) {
  const subscription = input?.subscription || input;
  if (!subscription || typeof subscription !== 'object') return null;
  if (!subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) return null;
  return {
    endpoint: String(subscription.endpoint),
    expirationTime: subscription.expirationTime ?? null,
    keys: {
      p256dh: String(subscription.keys.p256dh),
      auth: String(subscription.keys.auth),
    },
    userAgent: String(input?.userAgent || '').slice(0, 180),
    updatedAt: nowIso(),
  };
}

function readPushSubscriptions(filePath) {
  const parsed = safeJson(readTextFile(filePath), { subscriptions: [] });
  return Array.isArray(parsed?.subscriptions) ? parsed.subscriptions : [];
}

function writePushSubscriptions(filePath, subscriptions) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ updatedAt: nowIso(), subscriptions }, null, 2));
}

function upsertPushSubscription(filePath, input) {
  const subscription = normalizePushSubscription(input);
  if (!subscription) return { ok: false, error: 'invalid_push_subscription' };
  const existing = readPushSubscriptions(filePath)
    .filter((row) => row && row.endpoint !== subscription.endpoint);
  existing.push(subscription);
  writePushSubscriptions(filePath, existing);
  return { ok: true, count: existing.length, subscription };
}

function readRequestJson(req, maxBytes = 32_768) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('request_body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('invalid_json_body'));
      }
    });
    req.on('error', reject);
  });
}

export async function sendOpsPushEvent(event, options = {}) {
  const decision = classifyOpsPushEvent(event);
  if (!decision.shouldPush) return { ok: true, skipped: true, decision };
  const config = resolvePushConfig(options);
  if (!config.configured) return { ok: false, skipped: true, decision, error: 'push_not_configured' };
  const subscriptions = readPushSubscriptions(config.subscriptionPath);
  const payload = JSON.stringify({
    title: decision.title,
    body: decision.body,
    tag: decision.tag,
    reason: decision.reason,
    level: decision.level,
    ts: nowIso(),
  });
  const results = [];
  for (const subscription of subscriptions) {
    try {
      await config.webPush.sendNotification(subscription, payload);
      results.push({ endpoint: subscription.endpoint, ok: true });
    } catch (error) {
      results.push({ endpoint: subscription.endpoint, ok: false, error: String(error?.message || error).slice(0, 180) });
    }
  }
  return { ok: results.every((row) => row.ok), decision, sent: results.filter((row) => row.ok).length, total: results.length, results };
}

async function collectTownSquareEvents(options = {}) {
  const limit = Math.max(1, Math.min(200, Number(options.limit || DEFAULT_TOWN_LIMIT) || DEFAULT_TOWN_LIMIT));
  const team = options.team ? normalizeTeam(options.team) : '';
  const since = options.since ? new Date(options.since) : null;
  const queryReadonly = options.queryReadonly || pgPool.queryReadonly;
  const events = [];

  const transitionPath = path.join(process.env.HOME || '', '.ai-agent-system/workspace/sigma/transition-telemetry.jsonl');
  for (const item of readLatestJsonlEvents(transitionPath, 30)) {
    events.push(eventRow({
      ts: item.at,
      from: 'sigma',
      to: 'luna',
      text: `전이 ${item.counts?.applied ?? 0}건 적용 · matched=${item.counts?.matched ?? 0} · ${item.warnings?.join(', ') || 'warnings=0'}`,
      tag: 'transition',
      kind: 'transition',
      sourceId: item.type,
      accent: true,
    }));
  }

  const [vaultAudit, llmRoutes, hubAlarms, guardEvents, blogPosts, claudeOutcomes] = await Promise.all([
    safeQuery('sigma', 'sigma.vault_audit', `
      SELECT created_at, action, classifier, reasoning, applied, entry_id
      FROM sigma.vault_audit
      ORDER BY created_at DESC
      LIMIT $1
    `, [limit], queryReadonly),
    safeQuery('public', 'public.llm_routing_log', `
      SELECT created_at, caller_team, agent, provider, selected_route, success, error
      FROM public.llm_routing_log
      ORDER BY created_at DESC
      LIMIT $1
    `, [limit], queryReadonly),
    safeQuery('agent', 'agent.hub_alarms', `
      SELECT received_at, team, bot_name, severity, alarm_type, title, message, status, id
      FROM agent.hub_alarms
      ORDER BY received_at DESC
      LIMIT $1
    `, [limit], queryReadonly),
    safeQuery('investment', 'investment.guard_events', `
      SELECT triggered_at, guard_name, symbol, action, decision, reason, id
      FROM investment.guard_events
      ORDER BY triggered_at DESC
      LIMIT $1
    `, [limit], queryReadonly),
    safeQuery('blog', 'blog.posts', `
      SELECT created_at, title, slug, status, metadata, id
      FROM blog.posts
      ORDER BY created_at DESC
      LIMIT $1
    `, [limit], queryReadonly),
    safeQuery('claude', 'claude.auto_dev_outcomes', `
      SELECT created_at, rel_path, outcome, stage, test_pass, job_id, id
      FROM claude.auto_dev_outcomes
      ORDER BY created_at DESC
      LIMIT $1
    `, [limit], queryReadonly),
  ]);

  for (const row of vaultAudit) {
    if (row.__opsConsoleError) continue;
    events.push(eventRow({
      ts: row.created_at,
      from: 'sigma',
      to: 'orchestrator',
      text: `vault ${row.action || 'audit'} · applied=${row.applied === true} · ${row.reasoning || row.classifier || ''}`,
      tag: 'vault',
      kind: 'memory',
      sourceId: row.entry_id,
      accent: row.applied === true,
    }));
  }
  for (const row of llmRoutes) {
    if (row.__opsConsoleError) continue;
    events.push(eventRow({
      ts: row.created_at,
      from: row.caller_team || 'hub',
      to: row.agent || 'hub',
      text: `${row.provider || 'provider'} → ${row.selected_route || 'route'} · success=${row.success === true}${row.error ? ` · ${row.error}` : ''}`,
      tag: 'llm',
      kind: row.success === false ? 'fallback' : 'routing',
    }));
  }
  for (const row of hubAlarms) {
    if (row.__opsConsoleError) continue;
    events.push(eventRow({
      ts: row.received_at,
      from: row.team || row.bot_name || 'hub',
      to: 'hub',
      text: compactText([row.title, row.message, row.severity, row.status]),
      tag: row.severity || row.alarm_type || 'alarm',
      kind: 'alarm',
      sourceId: row.id,
      accent: String(row.severity || '').toLowerCase().includes('critical'),
    }));
  }
  for (const row of guardEvents) {
    if (row.__opsConsoleError) continue;
    events.push(eventRow({
      ts: row.triggered_at,
      from: 'luna',
      to: 'hub',
      text: `${row.guard_name || 'guard'} · ${row.symbol || '-'} ${row.action || ''} · ${row.decision || ''} · ${row.reason || ''}`,
      tag: 'guard',
      kind: 'guard',
      sourceId: row.id,
      accent: true,
    }));
  }
  for (const row of blogPosts) {
    if (row.__opsConsoleError) continue;
    const meta = safeJson(row.metadata, {});
    events.push(eventRow({
      ts: row.created_at,
      from: 'blog',
      to: 'hub',
      text: `${row.title || row.slug || 'post'} · ${row.status || 'posted'} · model=${meta.writer_model || 'n/a'}`,
      tag: 'publish',
      kind: 'publish',
      sourceId: row.id,
    }));
  }
  for (const row of claudeOutcomes) {
    if (row.__opsConsoleError) continue;
    events.push(eventRow({
      ts: row.created_at,
      from: 'claude',
      to: 'orchestrator',
      text: `${row.outcome || 'outcome'} · ${row.stage || 'stage'} · ${row.rel_path || row.job_id || ''} · test=${row.test_pass}`,
      tag: 'auto-dev',
      kind: 'commit',
      sourceId: row.id || row.job_id,
    }));
  }
  events.push(...readBridgeReportEvents(10));

  let filtered = events
    .filter((event) => !team || event.from === team || event.to === team)
    .filter((event) => !since || new Date(event.ts) >= since)
    .sort((a, b) => b.ts.localeCompare(a.ts));
  if (filtered.length === 0) {
    filtered = [eventRow({
      ts: nowIso(),
      from: 'hub',
      to: 'orchestrator',
      text: '타운스퀘어 read-only 소스에서 표시 가능한 이벤트가 아직 없습니다.',
      tag: 'empty',
      kind: 'system',
      accent: true,
    })];
  }
  return filtered.slice(0, limit);
}

function countLaunchdFailuresForTeam(snapshot, teamKey) {
  const failed = [
    ...(snapshot.launchd?.failed || []),
    ...(snapshot.launchd?.runningWithLastExit || []),
  ];
  const needle = teamKey === 'orchestrator' ? 'jay' : teamKey;
  return failed.filter((row) => String(row.label || '').toLowerCase().includes(needle)).length;
}

function serviceStatusForTeam(snapshot, teamKey) {
  const services = snapshot.health?.services || [];
  const map = {
    hub: ['hub', 'hub_ops_mcp'],
    ska: ['ska_ops_mcp'],
    luna: ['luna_ops_mcp'],
    blog: ['blog_node_server'],
    sigma: ['sigma_library_mcp'],
    darwin: ['darwin_ops_mcp'],
    claude: [],
    orchestrator: [],
    write: [],
  };
  const keys = map[teamKey] || [];
  const picked = services.filter((service) => keys.includes(service.key));
  if (picked.length === 0) return { ok: true, checked: 0, failed: 0 };
  return { ok: picked.every((item) => item.ok), checked: picked.length, failed: picked.filter((item) => !item.ok).length };
}

function metricForTeam(snapshot, teamKey) {
  const metric = snapshot.metrics || {};
  if (teamKey === 'ska') {
    const row = metric.ska?.todayReservations?.rows || {};
    return [`예약 ${row.total ?? 0}`, `취소 ${row.cancelled ?? 0}`];
  }
  if (teamKey === 'luna') return [`weak ${metric.luna?.weakSymbolHard24h?.count ?? 0}`, `guard 24h`];
  if (teamKey === 'blog') {
    const row = metric.blog?.sonnetTags24h?.rows || {};
    return [`발행태그 ${row.tagged ?? 0}`, `sonnet ${row.sonnet ?? 0}`];
  }
  if (teamKey === 'sigma') {
    const counts = metric.sigma?.transition?.counts || {};
    return [`전이 ${counts.applied ?? 0}`, `matched ${counts.matched ?? 0}`];
  }
  if (teamKey === 'hub') return [`chain ${metric.hub?.chainRequired24h?.count ?? 0}`, `svc ${snapshot.health?.checked ?? 0}`];
  if (teamKey === 'darwin') return [`제안 ${metric.darwin?.shadow?.total ?? 0}`, `shadow`];
  if (teamKey === 'claude') return [`auto-dev`, `outcomes`];
  if (teamKey === 'orchestrator') return [`jobs ${snapshot.launchd?.checked ?? 0}`, `fail ${snapshot.launchd?.failedCount ?? 0}`];
  return ['read-only', 'ready'];
}

function recentActivityForTeam(events, teamKey) {
  const event = events.find((row) => row.from === teamKey || row.to === teamKey);
  return event ? event.text : '최근 활동 없음';
}

function statusFromParts(service, launchdFailures) {
  if (!service.ok || launchdFailures > 0) return 'warn';
  return 'ok';
}

function buildHighlights(snapshot, events) {
  const highlights = [];
  if ((snapshot.launchd?.failedCount || 0) > 0) highlights.push(`launchd 실패 ${snapshot.launchd.failedCount}건 확인 필요`);
  const sigma = snapshot.metrics?.sigma?.transition?.counts;
  if (sigma) highlights.push(`시그마 전이 applied ${sigma.applied ?? 0} · matched ${sigma.matched ?? 0}`);
  const blog = snapshot.metrics?.blog?.sonnetTags24h?.rows;
  if (blog) highlights.push(`블로 24h writer tags ${blog.tagged ?? 0} · sonnet ${blog.sonnet ?? 0}`);
  for (const event of events.slice(0, 3)) {
    if (highlights.length >= 3) break;
    highlights.push(event.text);
  }
  while (highlights.length < 3) highlights.push('read-only 관제 데이터 수집 대기');
  return highlights.slice(0, 3);
}

async function collectOverview(options = {}) {
  const snapshot = await (options.buildSessionSnapshot || buildSessionSnapshot)({
    write: false,
    skipLaunchctl: options.skipLaunchctl === true,
    queryReadonly: options.queryReadonly,
    launchctlOutput: options.launchctlOutput,
  });
  const town = await collectTownSquareEvents({ limit: 20, queryReadonly: options.queryReadonly });
  const teams = Object.entries(TEAM_META).map(([key, meta]) => {
    const service = serviceStatusForTeam(snapshot, key);
    const launchdFailures = countLaunchdFailuresForTeam(snapshot, key);
    return {
      key,
      ...meta,
      status: statusFromParts(service, launchdFailures),
      service,
      launchdFailures,
      metrics: metricForTeam(snapshot, key),
      recent: recentActivityForTeam(town, key),
    };
  });
  const worst = teams.some((team) => team.status === 'bad') ? 'bad'
    : teams.some((team) => team.status === 'warn') ? 'warn'
      : 'ok';
  return {
    ok: true,
    readOnly: true,
    generatedAt: nowIso(),
    source: 'ops-console-d1',
    status: worst,
    clock: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }),
    highlights: buildHighlights(snapshot, town),
    teams,
    snapshot: {
      ok: snapshot.ok,
      generatedAt: snapshot.generatedAt,
      health: {
        ok: snapshot.health?.ok,
        checked: snapshot.health?.checked,
        failed: snapshot.health?.failed,
      },
      launchd: {
        checked: snapshot.launchd?.checked,
        failedCount: snapshot.launchd?.failedCount,
        runningWithLastExitCount: snapshot.launchd?.runningWithLastExitCount,
      },
      coreSignals: snapshot.metrics,
    },
  };
}

function createSseState(limit = 200) {
  return { id: 0, subscribers: new Set(), buffer: [], lastSeen: '' , limit };
}

function sseWrite(res, name, payload, id = null) {
  if (id != null) res.write(`id: ${id}\n`);
  res.write(`event: ${name}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function ssePush(state, event) {
  state.id += 1;
  const row = { id: state.id, event };
  state.buffer.push(row);
  if (state.buffer.length > state.limit) state.buffer.shift();
  for (const subscriber of Array.from(state.subscribers)) {
    try {
      if (subscriber.destroyed || subscriber.writableEnded) {
        state.subscribers.delete(subscriber);
        continue;
      }
      sseWrite(subscriber, 'townsquare', event, row.id);
    } catch {
      state.subscribers.delete(subscriber);
    }
  }
  return row;
}

function serveStatic(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const routePath = url.pathname === '/' ? '/index.html' : url.pathname;
  const normalized = path.normalize(routePath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(WEB_ROOT, normalized);
  if (!filePath.startsWith(WEB_ROOT) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return text(res, 404, 'not found');
  }
  const ext = path.extname(filePath).toLowerCase();
  const type = ext === '.js' ? 'application/javascript; charset=utf-8'
    : ext === '.css' ? 'text/css; charset=utf-8'
      : ext === '.json' ? 'application/manifest+json; charset=utf-8'
        : ext === '.webmanifest' ? 'application/manifest+json; charset=utf-8'
          : 'text/html; charset=utf-8';
  text(res, 200, fs.readFileSync(filePath), type);
}

export function createOpsConsoleServer(options = {}) {
  const sse = createSseState();
  let timer = null;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const method = req.method || 'GET';
      const pushSubscribe = method === 'POST' && url.pathname === '/api/push/subscribe';
      if (method !== 'GET' && method !== 'HEAD' && !pushSubscribe) {
        return json(res, 405, { ok: false, error: 'method_not_allowed' }, { allow: 'GET, HEAD, POST /api/push/subscribe' });
      }
      if (url.pathname === '/health') {
        return json(res, 200, { ok: true, service: 'ops-console', readOnly: true, port: Number(options.port || DEFAULT_PORT) });
      }
      if (url.pathname === '/api/bridge') {
        return json(res, 200, collectBridgeQueue({ bridgeRoot: options.bridgeRoot }));
      }
      if (url.pathname === '/api/push/vapid-public') {
        const push = resolvePushConfig(options);
        return json(res, 200, {
          ok: true,
          readOnly: true,
          configured: push.configured,
          publicKey: push.publicKey,
          subject: push.subject,
          subscriptionPath: push.subscriptionPath,
        });
      }
      if (pushSubscribe) {
        const push = resolvePushConfig(options);
        const body = await readRequestJson(req);
        const stored = upsertPushSubscription(push.subscriptionPath, {
          subscription: body.subscription || body,
          userAgent: req.headers['user-agent'] || '',
        });
        if (!stored.ok) return json(res, 400, stored);
        return json(res, 200, {
          ok: true,
          stored: true,
          count: stored.count,
          subscriptionPath: push.subscriptionPath,
          configured: push.configured,
        });
      }
      if (url.pathname === '/api/overview') {
        return json(res, 200, await collectOverview(options));
      }
      if (url.pathname === '/api/townsquare') {
        const payload = await collectTownSquareEvents({
          limit: url.searchParams.get('limit') || DEFAULT_TOWN_LIMIT,
          team: url.searchParams.get('team') || '',
          since: url.searchParams.get('since') || '',
          queryReadonly: options.queryReadonly,
        });
        return json(res, 200, { ok: true, readOnly: true, generatedAt: nowIso(), events: payload });
      }
      if (url.pathname === '/api/stream') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          ...STATIC_HEADERS,
        });
        const lastId = Number(req.headers['last-event-id'] || 0) || 0;
        sseWrite(res, 'hello', { ok: true, lastId, readOnly: true });
        for (const row of sse.buffer.filter((item) => item.id > lastId)) {
          sseWrite(res, 'townsquare', row.event, row.id);
        }
        sse.subscribers.add(res);
        req.on('close', () => sse.subscribers.delete(res));
        return;
      }
      serveStatic(req, res);
    } catch (error) {
      json(res, 500, { ok: false, error: 'ops_console_error', message: String(error?.message || error).slice(0, 240) });
    }
  });

  server.startTownSquareLoop = function startTownSquareLoop(intervalMs = TOWN_POLL_MS) {
    if (timer) return;
    timer = setInterval(async () => {
      try {
        const events = await collectTownSquareEvents({ limit: 10, queryReadonly: options.queryReadonly });
        const latest = events[0];
        const key = latest ? `${latest.ts}:${latest.kind}:${latest.text}` : '';
        if (latest && key !== sse.lastSeen) {
          sse.lastSeen = key;
          ssePush(sse, latest);
        }
      } catch (error) {
        ssePush(sse, eventRow({
          ts: nowIso(),
          from: 'hub',
          to: 'orchestrator',
          text: `ops-console stream collect failed · ${String(error?.message || error).slice(0, 120)}`,
          tag: 'stream',
          kind: 'system',
          accent: true,
        }));
      }
    }, Math.max(1000, Number(intervalMs || TOWN_POLL_MS)));
  };
  server.stopTownSquareLoop = function stopTownSquareLoop() {
    if (timer) clearInterval(timer);
    timer = null;
  };
  server.pushTownSquareEvent = (event) => ssePush(sse, event);
  server.sseState = sse;
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.OPS_CONSOLE_PORT || DEFAULT_PORT) || DEFAULT_PORT;
  const host = String(process.env.OPS_CONSOLE_HOST || DEFAULT_HOST);
  const server = createOpsConsoleServer({ port });
  server.startTownSquareLoop();
  server.listen(port, host, () => {
    console.log(`[ops-console] listening http://${host}:${port} readOnly=true root=${PROJECT_ROOT}`);
  });
}

export default {
  collectBridgeQueue,
  collectOverview,
  collectTownSquareEvents,
  createOpsConsoleServer,
  sendOpsPushEvent,
};
