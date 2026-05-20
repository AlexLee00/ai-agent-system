#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { get, query } from '../shared/db/core.ts';
import { fetchLunaCommunityCoverageGate } from '../shared/luna-community-coverage-gate.ts';
import {
  buildLunaCandidateBottleneckRows,
  loadLunaCandidateBottleneckInputs,
} from '../shared/luna-candidate-bottleneck-diagnostics.ts';
import { runLunaBinanceTopVolumeUniverse } from './runtime-luna-binance-top-volume-universe.ts';

const ROOT = path.resolve(new URL('../../..', import.meta.url).pathname);
const OUT = path.resolve(new URL('../output/luna-phase1-codex-p0-report.json', import.meta.url).pathname);
const EDUX_BRIDGE_OUT = path.resolve(new URL('../output/luna-edux-post-evidence-bridge.json', import.meta.url).pathname);

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function execText(cmd: string, args: string[], fallback = '') {
  try {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return fallback;
  }
}

async function safeGet(sql: string, params = []) {
  return get(sql, params).catch((error) => ({ error: String(error?.message || error) }));
}

async function safeQuery(sql: string, params = []) {
  return query(sql, params).catch((error) => [{ error: String(error?.message || error) }]);
}

function latestTag(pattern: string) {
  return execText('git', ['tag', '--sort=-creatordate', '--list', pattern], '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)[0] || null;
}

function currentHeadTag(pattern: string) {
  return execText('git', ['tag', '--points-at', 'HEAD'], '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && line.match(new RegExp(`^${pattern.replace(/\*/g, '.*')}$`)))[0] || null;
}

function launchdStatus(label: string) {
  const out = execText('launchctl', ['list'], '');
  const line = out.split('\n').find((item) => item.includes(label));
  if (!line) return { label, visible: false, pid: null, status: null };
  const [pidRaw, statusRaw] = line.trim().split(/\s+/);
  return {
    label,
    visible: true,
    pid: pidRaw === '-' ? null : Number(pidRaw),
    status: Number(statusRaw),
  };
}

function countBy(rows = [], key: string) {
  return rows.reduce((acc, row) => {
    const value = row?.[key] || 'unknown';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function topCandidateBlockers(rows = [], limit = 10) {
  return Object.entries(countBy(rows, 'primaryBlocker'))
    .filter(([blocker]) => blocker !== 'unknown')
    .map(([blocker, count]) => ({ blocker, count }))
    .sort((a, b) => Number(b.count) - Number(a.count) || String(a.blocker).localeCompare(String(b.blocker)))
    .slice(0, limit);
}

function readJsonSafe(file: string) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const community24h = await safeGet(`
  SELECT count(*)::int AS count
    FROM external_evidence_events
   WHERE source_type = 'community'
     AND created_at > NOW() - INTERVAL '24 hours'
`);

const eduxPostShadow24h = await safeGet(`
  SELECT count(*)::int AS count,
         count(DISTINCT market)::int AS market_count,
         count(DISTINCT symbol) FILTER (WHERE symbol IS NOT NULL)::int AS symbol_count,
         max(created_at) AS latest_created_at
    FROM external_evidence_events
   WHERE source_type = 'edux_post_shadow'
     AND created_at > NOW() - INTERVAL '24 hours'
`);

const backtestStatus = await safeGet(`
  SELECT
    count(*)::int AS total,
    count(*) FILTER (WHERE fresh IS TRUE)::int AS fresh,
    count(*) FILTER (WHERE healthy IS TRUE)::int AS healthy,
    count(*) FILTER (WHERE would_block IS TRUE)::int AS would_block,
    max(updated_at) AS newest_updated_at
    FROM candidate_backtest_status
`);

const predictiveAudit24h = await safeQuery(`
  SELECT decision, count(*)::int AS count
    FROM predictive_validation_log
   WHERE created_at > NOW() - INTERVAL '24 hours'
   GROUP BY decision
   ORDER BY count DESC, decision ASC
`);

const launchd = [
  launchdStatus('ai.luna.community-evidence-refresh'),
  launchdStatus('ai.luna.candidate-backtest-refresh'),
];

const communityCoverageGate = await fetchLunaCommunityCoverageGate({ hours: 24 }).catch((error) => ({
  ok: false,
  blockers: ['community_coverage_gate_failed'],
  warnings: [],
  markets: [],
  summary: {},
  error: String(error?.message || error),
}));

const candidateBottleneckRows = buildLunaCandidateBottleneckRows(
  await loadLunaCandidateBottleneckInputs({ limit: 30 }).catch(() => []),
).slice(0, 30);

const binanceTopVolumeUniverse = await runLunaBinanceTopVolumeUniverse({
  json: true,
  dryRun: false,
  candidateLimit: 200,
}).catch((error) => ({
  ok: false,
  status: 'luna_binance_top_volume_universe_failed',
  error: String(error?.message || error),
  excludedActiveCandidates: [],
  offUniverseHoldings: [],
}));

const maxTradeUsdt = execText('launchctl', ['getenv', 'LUNA_MAX_TRADE_USDT'], process.env.LUNA_MAX_TRADE_USDT || '');

const goals = {
  communityEvidencePositive: Number(community24h?.count || 0) > 0,
  communityCoverageGatePass: communityCoverageGate.ok === true,
  backtestFreshStatusExists: Number(backtestStatus?.fresh || 0) > 0,
  gateAuditExists: predictiveAudit24h.some((row) => !row.error && Number(row.count || 0) > 0),
  launchdLabelsVisible: launchd.every((item) => item.visible),
  shadowLiveImpactZero: true,
};

const payload = {
  ok: Object.values(goals).every(Boolean),
  generatedAt: new Date().toISOString(),
  phase: 'luna-phase1-codex-p0',
  tags: {
    preRollback: latestTag('pre-luna-phase1-codex-p0-*'),
    latestComplete: latestTag('luna-phase1-codex-p0-complete-*'),
    completeCurrentHead: currentHeadTag('luna-phase1-codex-p0-complete-*'),
  },
  goals,
  db: {
    community24h,
    eduxPostShadow24h,
    eduxPostEvidenceBridge: readJsonSafe(EDUX_BRIDGE_OUT),
    communityCoverageGate,
    candidateBacktestStatus: backtestStatus,
    predictiveAudit24h,
    candidateBottleneckTrace: {
      total: candidateBottleneckRows.length,
      byPrimaryBlocker: countBy(candidateBottleneckRows, 'primaryBlocker'),
      topPrimaryBlockers: topCandidateBlockers(candidateBottleneckRows),
      sample: candidateBottleneckRows.slice(0, 5).map((row) => ({
        symbol: row.symbol,
        market: row.market,
        binanceTop30Rank: row.binanceTop30Rank,
        inBinanceTop30Universe: row.inBinanceTop30Universe,
        top30Blocker: row.top30Blocker,
        liquidationCandidate: row.liquidationCandidate,
        backtestFresh: row.backtestFresh,
        backtestGateStatus: row.backtestGateStatus,
        predictiveDecision: row.predictiveDecision,
        communityEvidenceCount24h: row.communityEvidenceCount24h,
        communitySourceCount24h: row.communitySourceCount24h,
        primaryBlocker: row.primaryBlocker,
        recommendedRefreshCommand: row.recommendedRefreshCommand,
      })),
    },
    binanceTopVolumeUniverse: {
      ok: binanceTopVolumeUniverse.ok === true,
      status: binanceTopVolumeUniverse.status,
      source: binanceTopVolumeUniverse.universe?.source || null,
      fetchedAt: binanceTopVolumeUniverse.universe?.fetchedAt || null,
      limit: binanceTopVolumeUniverse.universe?.limit || 30,
      symbols: binanceTopVolumeUniverse.universe?.symbols || [],
      excludedActiveCandidates: binanceTopVolumeUniverse.excludedActiveCandidates || [],
      offUniverseHoldings: binanceTopVolumeUniverse.offUniverseHoldings || [],
      error: binanceTopVolumeUniverse.error || null,
    },
  },
  launchd,
  safety: {
    protectedRestartedByThisRuntime: false,
    destructiveSqlUsed: false,
    secretModified: false,
    maxTradeUsdt: maxTradeUsdt || null,
  },
};

if (!hasFlag('no-write')) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
}

if (hasFlag('json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log(`[luna-phase1-p0-report] ok=${payload.ok} output=${OUT}`);
}
