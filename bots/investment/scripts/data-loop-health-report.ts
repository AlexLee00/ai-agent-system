#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/data-loop-health-report.ts — 데이터-분석-피드백-학습 루프 건강 보고
 *
 * 매일 09:00 KST (guard-outcome-tracker 이후 실행)
 * launchd: ai.luna.data-loop-health-daily-0905.plist
 *
 * 측정 지표:
 *   1. 거래 수 (24h / 7d) — soft 가드 제거 효과
 *   2. guard_events outcome 분포 (success / failure / no_trade / pending)
 *   3. feedback_to_action_map 누적 건수
 *   4. luna_failure_reflexions 누적 건수
 *   5. agent_curriculum_state 레벨 분포
 *   6. v_luna_learning_progress 최근 학습 진행률
 *   7. LUNA_FULL_DATA_LOOP 활성 여부
 */

import { query, close } from '../shared/db/core.ts';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { maybeSkipForMemory } from '../shared/memory-pressure-guard.ts';

const require = createRequire(import.meta.url);
const { initHubConfig } = require('../../../packages/core/lib/llm-keys.js');

const TODAY = new Date().toISOString().split('T')[0];
const CRITICAL_LAUNCHD_ENV_KEYS_BY_LABEL: Record<string, string[]> = {
  'ai.luna.ops-scheduler': [
    'LUNA_V2_ENABLED',
    'LUNA_MAPEK_ENABLED',
    'LUNA_VALIDATION_ENABLED',
    'LUNA_PREDICTION_ENABLED',
    'LUNA_BT_ROBUST_SELECTION_ENABLED',
    'LUNA_BT_WALK_FORWARD_ENABLED',
    'LUNA_VECTORBT_TIMEOUT_MS',
  ],
  'ai.luna.candidate-backtest-refresh': [
    'LUNA_BT_ROBUST_SELECTION_ENABLED',
    'LUNA_BT_WALK_FORWARD_ENABLED',
    'LUNA_VECTORBT_TIMEOUT_MS',
  ],
};

async function fetchTradeStats() {
  const row24h = await query(
    `SELECT COUNT(*) AS cnt
     FROM investment.trade_journal
     WHERE exit_time IS NOT NULL
       AND NOT is_paper
       AND to_timestamp(exit_time / 1000.0) >= NOW() - INTERVAL '24 hours'`,
    [],
  ).catch(() => [{}]);
  const row7d = await query(
    `SELECT COUNT(*) AS cnt
     FROM investment.trade_journal
     WHERE exit_time IS NOT NULL
       AND NOT is_paper
       AND to_timestamp(exit_time / 1000.0) >= NOW() - INTERVAL '7 days'`,
    [],
  ).catch(() => [{}]);
  return {
    trades24h: Number(row24h?.[0]?.cnt || 0),
    trades7d: Number(row7d?.[0]?.cnt || 0),
  };
}

async function fetchGuardOutcomeStats() {
  const rows = await query(
    `SELECT
       outcome,
       COUNT(*) AS cnt
     FROM investment.guard_events
     WHERE triggered_at >= NOW() - INTERVAL '7 days'
     GROUP BY outcome
     ORDER BY outcome NULLS LAST`,
    [],
  ).catch(() => []);
  const stats = { success: 0, failure: 0, no_trade: 0, pending: 0, total: 0 };
  for (const r of (rows || [])) {
    const k = r.outcome === null ? 'pending' : String(r.outcome);
    stats[k] = Number(r.cnt || 0);
    stats.total += Number(r.cnt || 0);
  }
  const backlog = await query(
    `SELECT
       COUNT(*) FILTER (
         WHERE outcome IS NULL
           AND triggered_at < NOW() - INTERVAL '24 hours'
       ) AS pending_older_24h,
       COUNT(*) FILTER (
         WHERE outcome IS NULL
           AND triggered_at < NOW() - INTERVAL '4 hours'
       ) AS pending_older_4h
     FROM investment.guard_events
     WHERE triggered_at >= NOW() - INTERVAL '7 days'`,
    [],
  ).catch(() => [{}]);
  stats.pendingOlder24h = Number(backlog?.[0]?.pending_older_24h || 0);
  stats.pendingOlder4h = Number(backlog?.[0]?.pending_older_4h || 0);
  return stats;
}

async function fetchGuardEffectiveness() {
  const rows = await query(
    `SELECT guard_name, total_triggers, success_count, failure_count, success_rate_pct, avg_outcome_pnl_usd
     FROM investment.v_guard_effectiveness
     WHERE total_triggers > 0
     ORDER BY total_triggers DESC
     LIMIT 10`,
    [],
  ).catch(() => []);
  return rows || [];
}

async function fetchFeedbackStats() {
  const row = await query(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE applied_at >= NOW() - INTERVAL '7 days') AS recent7d
     FROM investment.feedback_to_action_map`,
    [],
  ).catch(() => [{}]);
  return {
    total: Number(row?.[0]?.total || 0),
    recent7d: Number(row?.[0]?.recent7d || 0),
  };
}

async function fetchReflexionStats() {
  const row = await query(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS recent7d
     FROM investment.luna_failure_reflexions`,
    [],
  ).catch(() => [{}]);
  return {
    total: Number(row?.[0]?.total || 0),
    recent7d: Number(row?.[0]?.recent7d || 0),
  };
}

async function fetchFeedbackLoopStallGuard({ hours = 36 } = {}) {
  const checks = [
    { table: 'investment.luna_failure_reflexions', tsCol: 'created_at' },
    { table: 'investment.feedback_to_action_map', tsCol: 'applied_at' },
    { table: 'investment.trade_decision_attribution', tsCol: 'created_at' },
  ];
  const results: {
    table: string;
    tsCol: string;
    status: 'ok' | 'stalled' | 'missing' | 'missing_column' | 'error';
    recentRows?: number;
    totalRows?: number;
    latest?: string | null;
    hours: number;
    message?: string;
  }[] = [];

  for (const check of checks) {
    const [schema, tableName] = check.table.split('.');
    try {
      const relation = await query(`SELECT to_regclass($1) AS rel`, [check.table])
        .then((rows) => rows?.[0]?.rel)
        .catch(() => null);
      if (!relation) {
        results.push({ ...check, status: 'missing', hours });
        continue;
      }
      const column = await query(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = $1
            AND table_name = $2
            AND column_name = $3
          LIMIT 1`,
        [schema, tableName, check.tsCol],
      ).then((rows) => rows?.[0]?.column_name).catch(() => null);
      if (!column) {
        results.push({ ...check, status: 'missing_column', hours, message: `${check.tsCol} column missing` });
        continue;
      }
      const row = await query(
        `SELECT
           COUNT(*)::int AS total_rows,
           COUNT(*) FILTER (WHERE ${check.tsCol} >= NOW() - ($1::int * INTERVAL '1 hour'))::int AS recent_rows,
           MAX(${check.tsCol}) AS latest
         FROM ${check.table}`,
        [hours],
      ).then((rows) => rows?.[0] || {}).catch(() => ({}));
      const recentRows = Number(row.recent_rows || 0);
      const totalRows = Number(row.total_rows || 0);
      const latest = row.latest ? new Date(row.latest).toISOString() : null;
      results.push({
        ...check,
        status: recentRows > 0 ? 'ok' : 'stalled',
        recentRows,
        totalRows,
        latest,
        hours,
      });
    } catch (err: any) {
      results.push({ ...check, status: 'error', hours, message: err?.message || String(err) });
    }
  }

  return results;
}

async function fetchCurriculumStats() {
  const rows = await query(
    `SELECT current_level, COUNT(*) AS cnt
     FROM investment.agent_curriculum_state
     GROUP BY current_level
     ORDER BY cnt DESC`,
    [],
  ).catch(() => []);
  const dist = {};
  for (const r of (rows || [])) {
    dist[String(r.current_level || 'unknown')] = Number(r.cnt || 0);
  }
  return dist;
}

async function fetchLearningProgress() {
  const rows = await query(
    `SELECT trade_date, AVG(learning_progress) AS avg_progress
     FROM investment.v_luna_learning_progress
     WHERE trade_date >= CURRENT_DATE - INTERVAL '7 days'
     GROUP BY trade_date
     ORDER BY trade_date DESC
     LIMIT 7`,
    [],
  ).catch(() => []);
  return rows || [];
}

function decodePlistValue(value = '') {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function extractPlistStringMap(plist = '') {
  const map: Record<string, string> = {};
  for (const match of plist.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)) {
    map[decodePlistValue(match[1])] = decodePlistValue(match[2]);
  }
  return map;
}

function extractPlistEnvironment(plist = '') {
  const envBlock = plist.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/)?.[1] || '';
  return extractPlistStringMap(envBlock);
}

function readLoadedLaunchdEnvironment(label: string) {
  const uid = process.getuid?.() || Number(spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout || 0);
  const result = spawnSync('launchctl', ['print', `gui/${uid}/${label}`], { encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0 || !result.stdout) return {};
  const env: Record<string, string> = {};
  for (const line of result.stdout.split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=>\s*(.*?)\s*$/);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

function installedLaunchAgentPath(label: string) {
  return `${process.env.HOME || '/Users/alexlee'}/Library/LaunchAgents/${label}.plist`;
}

async function fetchLaunchdHealth() {
  try {
    const launchdDir = new URL('../launchd', import.meta.url).pathname;
    const plistFiles = fs.readdirSync(launchdDir).filter((f) => f.endsWith('.plist'));

    const definedLabels: string[] = [];
    const repoEnvsByLabel: Record<string, Record<string, string>> = {};
    for (const file of plistFiles) {
      const content = fs.readFileSync(`${launchdDir}/${file}`, 'utf8');
      const match = content.match(/<key>Label<\/key>\s*<string>(.*?)<\/string>/);
      if (match) {
        const label = match[1].trim();
        definedLabels.push(label);
        repoEnvsByLabel[label] = extractPlistEnvironment(content);
      }
    }

    const result = spawnSync('launchctl', ['list'], { encoding: 'utf8', timeout: 5000 });
    const registeredLabels = new Set<string>();
    if (result.stdout) {
      for (const line of result.stdout.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3) registeredLabels.add(parts[2].trim());
      }
    }

    const unregistered = definedLabels.filter((l) => !registeredLabels.has(l));
    const envDrift: {
      label: string;
      key: string;
      repoValue: string | null;
      installedValue: string | null;
      loadedValue: string | null;
      installedPath: string;
      status: string;
    }[] = [];

    for (const [label, keys] of Object.entries(CRITICAL_LAUNCHD_ENV_KEYS_BY_LABEL)) {
      const repoEnv = repoEnvsByLabel[label] || {};
      const installedPath = installedLaunchAgentPath(label);
      const installedPlist = fs.existsSync(installedPath) ? fs.readFileSync(installedPath, 'utf8') : '';
      const installedEnv = installedPlist ? extractPlistEnvironment(installedPlist) : {};
      const loadedEnv = readLoadedLaunchdEnvironment(label);
      for (const key of keys) {
        const repoValue = repoEnv[key] ?? null;
        if (repoValue == null) continue;
        const installedValue = installedEnv[key] ?? null;
        const loadedValue = loadedEnv[key] ?? null;
        const installedMatches = installedValue === repoValue;
        const loadedMatches = loadedValue === repoValue;
        if (installedMatches && loadedMatches) continue;
        envDrift.push({
          label,
          key,
          repoValue,
          installedValue,
          loadedValue,
          installedPath,
          status: !installedPlist ? 'installed_plist_missing' : !installedMatches ? 'installed_env_mismatch' : 'loaded_env_mismatch',
        });
      }
    }

    return {
      defined: definedLabels.length,
      registered: definedLabels.length - unregistered.length,
      unregistered,
      envDrift,
    };
  } catch (err) {
    console.error('[DataLoopHealth] launchd 점검 실패:', err);
    return { defined: 0, registered: 0, unregistered: [], envDrift: [] };
  }
}

function loadDefinedOpsSchedulerJobNames() {
  try {
    const schedulerFile = new URL('./runtime-luna-ops-scheduler.ts', import.meta.url).pathname;
    const source = fs.readFileSync(schedulerFile, 'utf8');
    const names = [...source.matchAll(/\bname:\s*['"`]([^'"`]+)['"`]/g)].map((match) => match[1]);
    return new Set(names);
  } catch (err) {
    console.error('[DataLoopHealth] ops-scheduler 정의 점검 실패:', err);
    return null;
  }
}

async function fetchOpsSchedulerHealth() {
  try {
    const stateFile = new URL('../output/ops/luna-ops-scheduler-state.json', import.meta.url).pathname;
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const now = Date.now();
    const definedJobNames = loadDefinedOpsSchedulerJobNames();
    const staleJobs: { name: string; elapsedHours: number; thresholdHours: number }[] = [];
    const residueJobs: { name: string; elapsedHours: number }[] = [];

    for (const [name, job] of Object.entries(state.jobs || {})) {
      const lastRunAt = (job as any).lastRunAt;
      if (!lastRunAt) continue;

      const elapsedHours = (now - new Date(lastRunAt).getTime()) / 3_600_000;

      if (definedJobNames && !definedJobNames.has(name)) {
        residueJobs.push({ name, elapsedHours: Math.round(elapsedHours) });
        continue;
      }

      // 정의 파일을 읽지 못한 경우의 안전 fallback: 30일 이상 미실행은 stale 대신 잔재로 분류
      if (!definedJobNames && elapsedHours > 720) {
        residueJobs.push({ name, elapsedHours: Math.round(elapsedHours) });
        continue;
      }

      let thresholdHours = 48;
      if (/15min|30min|hourly/.test(name)) thresholdHours = 6;
      else if (/weekly/.test(name)) thresholdHours = 336;

      if (elapsedHours > thresholdHours) {
        staleJobs.push({ name, elapsedHours: Math.round(elapsedHours), thresholdHours });
      }
    }

    return { staleJobs, residueJobs };
  } catch (err) {
    console.error('[DataLoopHealth] ops-scheduler 점검 실패:', err);
    return { staleJobs: [], residueJobs: [] };
  }
}

async function fetchPositionSyncHealth() {
  const logPath = '/tmp/investment-runtime-autopilot.log';
  const counts = await query(
    `SELECT
       COUNT(*) FILTER (WHERE COALESCE(paper, false) = false) AS live_count,
       COUNT(*) FILTER (WHERE COALESCE(paper, false) = true) AS paper_count,
       COUNT(*) AS total_count
     FROM investment.positions`,
    [],
  ).then((rows) => ({
    liveCount: Number(rows?.[0]?.live_count || 0),
    paperCount: Number(rows?.[0]?.paper_count || 0),
    totalCount: Number(rows?.[0]?.total_count || 0),
  })).catch(() => ({ liveCount: 0, paperCount: 0, totalCount: 0 }));

  try {
    const stat = fs.statSync(logPath);
    const elapsedMin = (Date.now() - stat.mtimeMs) / 60000;
    // autopilot StartInterval=120초(2분), 15분 초과 → sync 정지 의심
    return {
      ...counts,
      lastRunMinAgo: Math.round(elapsedMin),
      status: elapsedMin > 15 ? 'critical' : 'ok',
    };
  } catch {
    return { ...counts, lastRunMinAgo: -1, status: 'missing_log' };
  }
}

async function fetchTableFreshness() {
  const checks = [
    // investment.positions는 데이터 나이 대신 sync 프로세스 생존(fetchPositionSyncHealth)으로 판정
    { table: 'investment.trade_journal', tsCol: 'entry_time', epochMs: true, expectHours: 168, criticalHours: 336 },
    { table: 'investment.market_regime_snapshots', tsCol: 'captured_at', epochMs: false, expectHours: 2, criticalHours: 24 },
    { table: 'investment.candidate_universe', tsCol: 'discovered_at', epochMs: false, expectHours: 48, criticalHours: 96 },
    { table: 'investment.guard_events', tsCol: 'triggered_at', epochMs: false, expectHours: 48, criticalHours: 96 },
    { table: 'investment.feedback_to_action_map', tsCol: 'applied_at', epochMs: false, expectHours: 48, criticalHours: 168 },
    { table: 'investment.luna_candidate_bottleneck_shadow', tsCol: 'observed_at', epochMs: false, expectHours: 24, criticalHours: 72 },
    { table: 'investment.luna_paper_trading_shadow', tsCol: 'observed_at', epochMs: false, expectHours: 24, criticalHours: 72 },
  ];

  const results: {
    table: string;
    status: 'ok' | 'stale' | 'missing' | 'missing_column' | 'error';
    elapsedHours?: number;
    expectHours: number;
    criticalHours: number;
    latest?: string | null;
    message?: string;
  }[] = [];

  for (const { table, tsCol, epochMs, expectHours, criticalHours } of checks) {
    const [schema, tableName] = table.split('.');
    try {
      const relation = await query(
        `SELECT to_regclass($1) AS rel`,
        [table],
      ).then((rows) => rows?.[0]?.rel).catch(() => null);
      if (!relation) {
        results.push({ table, status: 'missing', expectHours, criticalHours });
        continue;
      }

      const column = await query(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = $1
            AND table_name = $2
            AND column_name = $3
          LIMIT 1`,
        [schema, tableName, tsCol],
      ).then((rows) => rows?.[0]?.column_name).catch(() => null);
      if (!column) {
        results.push({ table, status: 'missing_column', expectHours, criticalHours, message: `${tsCol} column missing` });
        continue;
      }

      const tsExpr = epochMs ? `to_timestamp(MAX(${tsCol}) / 1000.0)` : `MAX(${tsCol})`;
      const rows = await query(`SELECT ${tsExpr} AS latest FROM ${table}`, []);
      const latest = rows?.[0]?.latest;
      if (!latest) {
        results.push({ table, status: 'stale', elapsedHours: undefined, expectHours, criticalHours, latest: null });
        continue;
      }
      const elapsedHours = (Date.now() - new Date(latest).getTime()) / 3_600_000;
      let status = elapsedHours > expectHours ? 'stale' : 'ok';
      let message;
      if (status === 'stale' && table === 'investment.feedback_to_action_map') {
        const mapperState = readFeedbackActionMapperState();
        if (mapperState.ok && mapperState.elapsedHours <= expectHours) {
          status = 'ok';
          message = `feedback mapper ran ${mapperState.elapsedHours}h ago with mapped=${mapperState.mapped}; no new action rows is acceptable`;
        }
      }
      results.push({
        table,
        status,
        elapsedHours: Math.round(elapsedHours),
        expectHours,
        criticalHours,
        latest: new Date(latest).toISOString(),
        message,
      });
    } catch (err: any) {
      const message = err?.message || String(err);
      const isMissing = /relation .* does not exist/i.test(message);
      results.push({ table, status: isMissing ? 'missing' : 'error', expectHours, criticalHours, message });
    }
  }

  return results;
}

function readFeedbackActionMapperState() {
  try {
    const statePath = new URL('../output/ops/luna-feedback-action-mapper-state.json', import.meta.url).pathname;
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const ts = state.stateWrittenAt || state.generatedAt;
    const elapsedHours = ts ? Math.round((Date.now() - new Date(ts).getTime()) / 3_600_000) : Number.POSITIVE_INFINITY;
    return {
      ok: state.ok === true,
      elapsedHours,
      mapped: Number(state.mapped || 0),
    };
  } catch {
    return { ok: false, elapsedHours: Number.POSITIVE_INFINITY, mapped: 0 };
  }
}

function buildFreshnessSection(launchd, opsScheduler, tableFreshness, positionSync?, feedbackLoopStall?) {
  const tables: any[] = Array.isArray(tableFreshness) ? tableFreshness : [];
  const feedbackStalls: any[] = Array.isArray(feedbackLoopStall) ? feedbackLoopStall : [];
  const staleJobs: any[] = opsScheduler?.staleJobs ?? [];
  const residueJobs: any[] = opsScheduler?.residueJobs ?? [];
  const unregistered: string[] = launchd?.unregistered ?? [];
  const envDrift: any[] = launchd?.envDrift ?? [];
  const ldDefined: number = launchd?.defined ?? 0;
  const ldRegistered: number = launchd?.registered ?? 0;

  let section = `*7. 프로세스/테이블 신선도*\n`;
  let hasCritical = false;
  let hasWarn = false;

  // Position sync 생존 (데이터 나이 대신 sync 프로세스 기준)
  if (positionSync) {
    if (positionSync.status === 'ok') {
      if (Number(positionSync.liveCount || 0) === 0) {
        section += `✅ positions: live 보유 없음 정상 (sync 가동 중, ${positionSync.lastRunMinAgo}분 전)\n`;
      } else {
        section += `✅ positions: live ${positionSync.liveCount}건 추적 중 (sync 가동 중, ${positionSync.lastRunMinAgo}분 전)\n`;
      }
      if (Number(positionSync.paperCount || 0) > 0) {
        section += `ℹ️ positions: paper 고아 후보 ${positionSync.paperCount}건 (archive 대상)\n`;
      }
    } else if (positionSync.status === 'critical') {
      section += `🔴 CRITICAL: position-sync 정지 ${positionSync.lastRunMinAgo}분 (autopilot 로그 미갱신)\n`;
      hasCritical = true;
    } else {
      section += `⚠️ WARN: autopilot 로그 없음 (position-sync 상태 불명)\n`;
      hasWarn = true;
    }
  }

  // Feedback-loop stall guard: daily learning jobs should write at least one row within 36h.
  for (const f of feedbackStalls) {
    if (f.status === 'ok') continue;
    if (f.status === 'missing') {
      section += `🔴 CRITICAL: feedback loop table \`${f.table}\` MISSING\n`;
    } else if (f.status === 'missing_column') {
      section += `🔴 CRITICAL: feedback loop table \`${f.table}\` ${f.message || 'timestamp column missing'}\n`;
    } else if (f.status === 'error') {
      section += `⚠️ WARN: feedback loop \`${f.table}\` stall check error: ${String(f.message || 'unknown').slice(0, 120)}\n`;
      hasWarn = true;
      continue;
    } else {
      section += `🔴 CRITICAL: feedback loop \`${f.table}\` 신규 row 0건/${f.hours || 36}h (latest=${f.latest || 'none'})\n`;
    }
    hasCritical = true;
  }

  // Table freshness
  for (const t of tables) {
    if (t.status === 'missing') {
      section += `🔴 CRITICAL: \`${t.table}\` MISSING\n`;
      hasCritical = true;
    } else if (t.status === 'missing_column') {
      section += `🔴 CRITICAL: \`${t.table}\` ${t.message || 'timestamp column missing'}\n`;
      hasCritical = true;
    } else if (t.status === 'error') {
      section += `⚠️ WARN: \`${t.table}\` freshness check error: ${String(t.message || 'unknown').slice(0, 120)}\n`;
      hasWarn = true;
    } else if (t.status === 'stale') {
      const hrs = t.elapsedHours !== undefined ? `${t.elapsedHours}h` : '?h';
      if ((t.elapsedHours ?? Number.POSITIVE_INFINITY) > (t.criticalHours ?? 24)) {
        section += `🔴 CRITICAL: \`${t.table}\` STALE ${hrs} (기대: ${t.expectHours}h)\n`;
        hasCritical = true;
      } else {
        section += `⚠️ WARN: \`${t.table}\` STALE ${hrs} (기대: ${t.expectHours}h)\n`;
        hasWarn = true;
      }
    }
  }

  // Ops-scheduler stale jobs
  for (const j of staleJobs) {
    section += `⚠️ WARN: ops \`${j.name}\` ${j.elapsedHours}h 정지 (기대: ${j.thresholdHours}h)\n`;
    hasWarn = true;
  }

  if (residueJobs.length > 0) {
    const sample = residueJobs.slice(0, 3).map((job) => `\`${job.name}\``).join(', ');
    section += `ℹ️ ops 정의 외 state 잔재 ${residueJobs.length}개 무시${sample ? ` (${sample})` : ''}\n`;
  }

  // Launchd unregistered
  if (unregistered.length > 0) {
    section += `⚠️ WARN: launchd 미등록 ${unregistered.length}개:\n`;
    for (const l of unregistered) {
      section += `  • \`${l}\`\n`;
    }
    hasWarn = true;
  }

  // Launchd env drift: repo source and installed/loaded launchd must agree on critical safety/data-loop flags.
  for (const drift of envDrift) {
    section += `🔴 CRITICAL: launchd env drift \`${drift.label}\` ${drift.key} repo=${drift.repoValue ?? 'unset'} installed=${drift.installedValue ?? 'unset'} loaded=${drift.loadedValue ?? 'unset'} (${drift.status || 'mismatch'})\n`;
    hasCritical = true;
  }

  if (!hasCritical && !hasWarn) {
    section += `✅ 모두 정상 (미등록/stale 없음)\n`;
  }

  section += `  launchd: ${ldRegistered}/${ldDefined} 등록\n`;
  return { section, hasCritical };
}

function buildTelegramMessage(data) {
  const { trades, guardOutcome, guardTop, feedback, reflexion, curriculum, learning, fullDataLoop, launchd, opsScheduler, tableFreshness, positionSync, feedbackLoopStall } = data;
  const loopStatus = fullDataLoop ? '🟢 ENABLED' : '🟡 DISABLED (shadow)';
  const guardOutcomeBacklogCritical = Number(guardOutcome.pendingOlder24h || 0) > 500;

  let msg = `📊 *루나 데이터 루프 건강 보고 — ${TODAY}*\n\n`;
  msg += `🔄 LUNA_FULL_DATA_LOOP: ${loopStatus}\n\n`;

  msg += `*1. 거래 (데이터 수집)*\n`;
  msg += `  • 24h: ${trades.trades24h}건\n`;
  msg += `  • 7d: ${trades.trades7d}건\n\n`;

  msg += `*2. 가드 이벤트 아웃컴 (7d)*\n`;
  msg += `  • 전체: ${guardOutcome.total}건\n`;
  msg += `  • ✅ success: ${guardOutcome.success}\n`;
  msg += `  • ❌ failure: ${guardOutcome.failure}\n`;
  msg += `  • ⚪ no_trade: ${guardOutcome.no_trade}\n`;
  msg += `  • ⏳ pending: ${guardOutcome.pending}\n`;
  if (Number(guardOutcome.pendingOlder24h || 0) > 0) {
    msg += `  • ${guardOutcomeBacklogCritical ? '🔴' : '⚠️'} pending>24h: ${guardOutcome.pendingOlder24h}건 (eligible>4h ${guardOutcome.pendingOlder4h || 0}건)\n`;
  }

  if (guardOutcome.success + guardOutcome.failure > 0) {
    const successRate = Math.round(100 * guardOutcome.success / (guardOutcome.success + guardOutcome.failure));
    msg += `  • 승률: ${successRate}%\n`;
  }
  msg += '\n';

  if (guardTop.length > 0) {
    msg += `*3. 가드별 효과 (Top 5)*\n`;
    for (const g of guardTop.slice(0, 5)) {
      const rate = g.success_rate_pct ? `${Number(g.success_rate_pct).toFixed(1)}%` : '-';
      msg += `  • \`${g.guard_name}\`: ${g.total_triggers}건 (승률 ${rate})\n`;
    }
    msg += '\n';
  }

  msg += `*4. 피드백 누적*\n`;
  msg += `  • feedback_to_action_map: 총 ${feedback.total}건 (7d +${feedback.recent7d})\n`;
  msg += `  • failure_reflexions: 총 ${reflexion.total}건 (7d +${reflexion.recent7d})\n\n`;

  msg += `*5. 에이전트 진화*\n`;
  const levels = Object.entries(curriculum).map(([k, v]) => `${k}:${v}`).join(' / ');
  msg += `  • 커리큘럼 레벨: ${levels || '없음'}\n\n`;

  if (learning.length > 0) {
    const latest = learning[0];
    msg += `*6. 학습 진행률 (최근)*\n`;
    msg += `  • ${latest.trade_date}: ${Number(latest.avg_progress || 0).toFixed(3)}\n\n`;
  }

  const { section: freshnessSection, hasCritical } = buildFreshnessSection(launchd, opsScheduler, tableFreshness, positionSync, feedbackLoopStall);
  msg += freshnessSection + '\n';

  const statusEmoji = hasCritical || guardOutcomeBacklogCritical ? '🚨' : '✅';
  msg += `_${statusEmoji} 데이터 루프: 거래 → 분석 → 피드백 → 학습 → 진화 ♻️_`;
  return msg;
}

async function sendTelegram(message) {
  try {
    const hubUrl = process.env.HUB_URL || 'http://localhost:7788';
    const hubToken = process.env.HUB_AUTH_TOKEN;
    if (!hubToken) return;
    await fetch(`${hubUrl}/hub/notifications/telegram`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hubToken}`,
      },
      body: JSON.stringify({ message, source: 'data-loop-health-report', parseMode: 'Markdown' }),
    }).catch(() => null);
  } catch {
    // ignore
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const json = process.argv.includes('--json');
  if (maybeSkipForMemory('luna.data-loop-health', { json })) return;
  if (!json) console.log(`[DataLoopHealth] ${new Date().toISOString()} 루프 건강 보고 시작`);

  try {
    await initHubConfig().catch(() => null);
  } catch {}

  const fullDataLoop = !['0', 'false', 'no', 'off', 'disabled']
    .includes(String(process.env.LUNA_FULL_DATA_LOOP_ENABLED ?? 'true').toLowerCase());

  const [trades, guardOutcome, guardTop, feedback, reflexion, curriculum, learning, launchd, opsScheduler, tableFreshness, positionSync, feedbackLoopStall] = await Promise.allSettled([
    fetchTradeStats(),
    fetchGuardOutcomeStats(),
    fetchGuardEffectiveness(),
    fetchFeedbackStats(),
    fetchReflexionStats(),
    fetchCurriculumStats(),
    fetchLearningProgress(),
    fetchLaunchdHealth(),
    fetchOpsSchedulerHealth(),
    fetchTableFreshness(),
    fetchPositionSyncHealth(),
    fetchFeedbackLoopStallGuard(),
  ]).then((results) => results.map((r) => r.status === 'fulfilled' ? r.value : r.status === 'rejected' ? {} : {}));

  const data = { trades, guardOutcome, guardTop, feedback, reflexion, curriculum, learning, fullDataLoop, launchd, opsScheduler, tableFreshness, positionSync, feedbackLoopStall };

  if (!json) {
    console.log(`[DataLoopHealth] 거래: 24h=${trades.trades24h} 7d=${trades.trades7d}`);
    console.log(`[DataLoopHealth] 가드 아웃컴: 총${guardOutcome.total} success=${guardOutcome.success} failure=${guardOutcome.failure} no_trade=${guardOutcome.no_trade} pendingOlder24h=${guardOutcome.pendingOlder24h || 0}`);
    console.log(`[DataLoopHealth] 피드백: ${feedback.total}건 | reflexion: ${reflexion.total}건`);
    console.log(`[DataLoopHealth] LUNA_FULL_DATA_LOOP: ${fullDataLoop}`);
    console.log(`[DataLoopHealth] launchd: ${launchd.registered ?? '?'}/${launchd.defined ?? '?'} 등록, 미등록 ${(launchd.unregistered ?? []).length}개`);
    console.log(`[DataLoopHealth] launchd env drift: ${(launchd.envDrift ?? []).map((item) => `${item.label}:${item.key}(${item.status})`).join(', ') || 'clear'}`);
    console.log(`[DataLoopHealth] ops stale jobs: ${(opsScheduler.staleJobs ?? []).length}개, residue ignored ${(opsScheduler.residueJobs ?? []).length}개`);
  }
  const tableFreshnessRows = Array.isArray(tableFreshness) ? tableFreshness : [];
  const feedbackLoopStallRows = Array.isArray(feedbackLoopStall) ? feedbackLoopStall : [];
  const criticalTables = tableFreshnessRows.filter((t) =>
    ['missing', 'missing_column'].includes(t.status)
    || (t.status === 'stale' && (t.elapsedHours ?? Number.POSITIVE_INFINITY) > (t.criticalHours ?? 24)),
  );
  if (!json) {
    console.log(`[DataLoopHealth] 테이블 CRITICAL: ${criticalTables.map((t) => `${t.table}(${t.status})`).join(', ') || '없음'}`);
    console.log(`[DataLoopHealth] position-sync: status=${positionSync?.status ?? '?'} lastRunMinAgo=${positionSync?.lastRunMinAgo ?? '?'} live=${positionSync?.liveCount ?? '?'} paper=${positionSync?.paperCount ?? '?'}`);
  }
  const stalledFeedback = feedbackLoopStallRows.filter((item) => item.status !== 'ok');
  if (!json) console.log(`[DataLoopHealth] feedback-loop stall guard: ${stalledFeedback.map((item) => `${item.table}(${item.status})`).join(', ') || 'clear'}`);

  const message = buildTelegramMessage(data);
  if (!dryRun) {
    await sendTelegram(message);
  } else if (!json) {
    console.log('[DataLoopHealth][dry] Telegram 메시지:');
    console.log(message);
  }
  if (json) console.log(JSON.stringify({ ok: true, dryRun, data, message }, null, 2));

  try { await close(); } catch {}
  process.exit(0);
}

main().catch((err) => {
  console.error('[DataLoopHealth] 실패:', err);
  process.exit(1);
});
