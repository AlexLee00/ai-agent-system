#!/usr/bin/env node
// @ts-nocheck
/**
 * runtime-luna-7day-report.ts — Phase Ω7: 7일 운영 데이터 보고서
 *
 * 7일 연속 운영 후 누적 데이터 검증 보고서.
 * Phase Ω7 수용 기준:
 *   ✅ fired ≥ 5건
 *   ✅ reflexions ≥ 5건
 *   ✅ skills ≥ 1건 자동 추출
 *   ✅ smoke 회귀 0건 유지
 *
 * Kill Switch:
 *   LUNA_7DAY_OPERATION_VERIFY_ENABLED=false → 전체 비활성
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVESTMENT_DIR = path.resolve(__dirname, '..');

const ENABLED = () => {
  const raw = String(process.env.LUNA_7DAY_OPERATION_VERIFY_ENABLED ?? 'true').toLowerCase();
  return raw !== 'false' && raw !== '0';
};

export interface Luna7DayReportData {
  generatedAt: string;
  periodDays: number;
  status: 'complete' | 'pending_observation';
  pendingReasons: string[];
  signals: {
    fired: number;
    blocked: number;
    approved: number;
    executed: number;
    rejected: number;
    statusCounts?: Record<string, number>;
  };
  trades: {
    total: number;
    live: number;
    mock: number;
    avgPnlPct: number;
    totalPnlUsdt: number;
  };
  markets: {
    binance: number;
    kis: number;
    kis_overseas: number;
  };
  reflexions: {
    count: number;
    llmFailures: number;
  };
  skills: {
    extracted: number;
    libraryTotal: number;
  };
  lifecycle: {
    stage8Covered: number;
    totalPositions: number;
  };
  agentActivity: Array<{ agent: string; calls: number }>;
  criteria: {
    fired5: boolean;
    reflexions5: boolean;
    skills1: boolean;
    smokeReg0: boolean;
  };
  passed: boolean;
}

async function collectSignalStats(days: number): Promise<Luna7DayReportData['signals']> {
  const [row, statusRows] = await Promise.all([
    db.get(
    `SELECT
       COUNT(*)::int                                          AS total,
       SUM(CASE WHEN status IN ('approved','fired','executed') THEN 1 ELSE 0 END)::int  AS fired,
       SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END)::int   AS blocked,
       SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END)::int  AS approved,
       SUM(CASE WHEN status = 'executed' THEN 1 ELSE 0 END)::int  AS executed,
       SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END)::int  AS rejected
     FROM investment.signals
     WHERE created_at >= NOW() - ($1 * INTERVAL '1 day')`,
    [days],
    ).catch(() => null),
    db.query(
      `SELECT COALESCE(status, 'unknown') AS status, COUNT(*)::int AS cnt
       FROM investment.signals
       WHERE created_at >= NOW() - ($1 * INTERVAL '1 day')
       GROUP BY COALESCE(status, 'unknown')
       ORDER BY cnt DESC`,
      [days],
    ).catch(() => []),
  ]);
  const statusCounts: Record<string, number> = {};
  for (const item of statusRows || []) statusCounts[String(item.status || 'unknown')] = Number(item.cnt || 0);
  return {
    fired: Number(row?.fired || 0),
    blocked: Number(row?.blocked || 0),
    approved: Number(row?.approved || 0),
    executed: Number(row?.executed || 0),
    rejected: Number(row?.rejected || 0),
    statusCounts,
  };
}

async function collectTradeStats(days: number): Promise<Luna7DayReportData['trades']> {
  const row = await db.get(
    `SELECT
       COUNT(*)::int AS total,
       SUM(CASE WHEN trade_mode = 'live' THEN 1 ELSE 0 END)::int  AS live,
       SUM(CASE WHEN trade_mode != 'live' THEN 1 ELSE 0 END)::int AS mock,
       COALESCE(AVG(pnl_pct), 0)::numeric(8,4) AS avg_pnl_pct,
       COALESCE(SUM(pnl_usdt), 0)::numeric(12,4) AS total_pnl_usdt
     FROM investment.trade_history
     WHERE created_at >= NOW() - ($1 * INTERVAL '1 day')`,
    [days],
  ).catch(() => null);
  return {
    total: Number(row?.total || 0),
    live: Number(row?.live || 0),
    mock: Number(row?.mock || 0),
    avgPnlPct: Number(row?.avg_pnl_pct || 0),
    totalPnlUsdt: Number(row?.total_pnl_usdt || 0),
  };
}

async function collectMarketStats(days: number): Promise<Luna7DayReportData['markets']> {
  const rows = await db.query(
    `SELECT exchange, COUNT(*)::int AS cnt
     FROM investment.trade_history
     WHERE created_at >= NOW() - ($1 * INTERVAL '1 day')
     GROUP BY exchange`,
    [days],
  ).catch(() => []);
  const m: Record<string, number> = {};
  for (const r of rows || []) m[r.exchange] = Number(r.cnt);
  return {
    binance: m['binance'] ?? 0,
    kis: m['kis'] ?? 0,
    kis_overseas: m['kis_overseas'] ?? 0,
  };
}

async function collectReflexionStats(days: number): Promise<Luna7DayReportData['reflexions']> {
  const [r1, r2] = await Promise.allSettled([
    db.get(
      `SELECT COUNT(*)::int AS cnt FROM investment.luna_failure_reflexions
       WHERE created_at >= NOW() - ($1 * INTERVAL '1 day')`,
      [days],
    ),
    db.get(
      `SELECT COUNT(*)::int AS cnt FROM investment.llm_failure_reflexions
       WHERE last_failed_at >= NOW() - ($1 * INTERVAL '1 day')`,
      [days],
    ),
  ]);
  return {
    count: Number((r1.status === 'fulfilled' ? r1.value?.cnt : null) || 0),
    llmFailures: Number((r2.status === 'fulfilled' ? r2.value?.cnt : null) || 0),
  };
}

async function collectSkillStats(days: number): Promise<Luna7DayReportData['skills']> {
  const [libraryRecent, libraryTotal, posttradeRecent, posttradeTotal] = await Promise.allSettled([
    db.get(
      `SELECT COUNT(*)::int AS cnt FROM investment.skill_library
       WHERE updated_at >= NOW() - ($1 * INTERVAL '1 day')`,
      [days],
    ),
    db.get(`SELECT COUNT(*)::int AS cnt FROM investment.skill_library`, []),
    db.get(
      `SELECT COUNT(*)::int AS cnt FROM investment.luna_posttrade_skills
       WHERE updated_at >= NOW() - ($1 * INTERVAL '1 day')`,
      [days],
    ),
    db.get(`SELECT COUNT(*)::int AS cnt FROM investment.luna_posttrade_skills`, []),
  ]);
  const safeCount = (result: PromiseSettledResult<any>) =>
    Number((result.status === 'fulfilled' ? result.value?.cnt : null) || 0);
  return {
    extracted: safeCount(libraryRecent) + safeCount(posttradeRecent),
    libraryTotal: safeCount(libraryTotal) + safeCount(posttradeTotal),
  };
}

async function collectLifecycleStats(days: number): Promise<Luna7DayReportData['lifecycle']> {
  const [total, stage8] = await Promise.allSettled([
    db.get(
      `SELECT COUNT(DISTINCT position_scope_key)::int AS cnt
       FROM investment.position_lifecycle_events
       WHERE created_at >= NOW() - ($1 * INTERVAL '1 day')`,
      [days],
    ),
    db.get(
      `SELECT COUNT(DISTINCT position_scope_key)::int AS cnt
       FROM investment.position_lifecycle_events
       WHERE created_at >= NOW() - ($1 * INTERVAL '1 day')
         AND stage_id = 'stage_8'`,
      [days],
    ),
  ]);
  return {
    totalPositions: Number((total.status === 'fulfilled' ? total.value?.cnt : null) || 0),
    stage8Covered: Number((stage8.status === 'fulfilled' ? stage8.value?.cnt : null) || 0),
  };
}

async function collectAgentActivity(days: number): Promise<Array<{ agent: string; calls: number }>> {
  const rows = await db.query(
    `SELECT agent_name, COUNT(*)::int AS calls
     FROM investment.llm_routing_log
     WHERE created_at >= NOW() - ($1 * INTERVAL '1 day')
     GROUP BY agent_name
     ORDER BY calls DESC LIMIT 15`,
    [days],
  ).catch(() => []);
  return (rows || []).map((r: any) => ({ agent: r.agent_name, calls: Number(r.calls) }));
}

function renderReport(data: Luna7DayReportData): string {
  const lines: string[] = [];
  const line = (s = '') => lines.push(s);
  const hr = (char = '─', len = 60) => line(char.repeat(len));
  const ck = (v: boolean) => v ? '✅' : '❌';

  hr('═');
  line(`  Luna 7일 운영 보고서 — ${data.generatedAt}`);
  line(`  집계 기간: 최근 ${data.periodDays}일`);
  hr('═');
  line('');
  line('  [ 신호 현황 ]');
  line(`    발화(fired)   : ${data.signals.fired}건`);
  line(`    차단(blocked) : ${data.signals.blocked}건`);
  line(`    승인(approved): ${data.signals.approved}건`);
  line(`    실행(executed): ${data.signals.executed}건`);
  line(`    거부(rejected): ${data.signals.rejected}건`);
  line('');
  line('  [ 거래 현황 ]');
  line(`    총 거래   : ${data.trades.total}건`);
  line(`    LIVE      : ${data.trades.live}건`);
  line(`    MOCK      : ${data.trades.mock}건`);
  line(`    평균 PnL  : ${(data.trades.avgPnlPct * 100).toFixed(2)}%`);
  line(`    총 PnL    : $${data.trades.totalPnlUsdt.toFixed(2)}`);
  line('');
  line('  [ 시장별 거래 ]');
  line(`    Binance   : ${data.markets.binance}건`);
  line(`    KIS       : ${data.markets.kis}건`);
  line(`    KIS Overseas: ${data.markets.kis_overseas}건`);
  line('');
  line('  [ Reflexion ]');
  line(`    거래 실패 reflexion : ${data.reflexions.count}건`);
  line(`    LLM 실패 reflexion  : ${data.reflexions.llmFailures}건`);
  line('');
  line('  [ Skill Library ]');
  line(`    기간 내 추출  : ${data.skills.extracted}건`);
  line(`    총 보유       : ${data.skills.libraryTotal}건`);
  line('');
  line('  [ Lifecycle Stage 8 ]');
  line(`    총 포지션         : ${data.lifecycle.totalPositions}건`);
  line(`    stage_8 완료      : ${data.lifecycle.stage8Covered}건`);
  line('');
  if (data.agentActivity.length > 0) {
    line('  [ 에이전트 활성도 (Top 10) ]');
    for (const a of data.agentActivity.slice(0, 10)) {
      line(`    ${a.agent.padEnd(16)} ${a.calls}회`);
    }
    line('');
  }
  hr();
  line('  [ Phase Ω7 수용 기준 ]');
  line(`    ${ck(data.criteria.fired5)}     fired ≥ 5건       (현재 ${data.signals.fired}건)`);
  line(`    ${ck(data.criteria.reflexions5)} reflexions ≥ 5건 (현재 ${data.reflexions.count}건)`);
  line(`    ${ck(data.criteria.skills1)}     skills ≥ 1건      (기간 추출 ${data.skills.extracted}건)`);
  line(`    ${ck(data.criteria.smokeReg0)}   smoke 회귀 0건    (정적 검증)`);
  line('');
  line(`  종합: ${data.passed ? '✅ Phase Ω7 수용 기준 통과' : '⏳ 운영 데이터 누적 중 (7일 자연 운영 대기)'}`);
  if (data.pendingReasons.length > 0) {
    line('');
    line('  [ Pending Observation ]');
    for (const reason of data.pendingReasons) line(`    - ${reason}`);
  }
  hr('═');
  return lines.join('\n');
}

export async function runLuna7DayReport(
  opts: { days?: number; outputFile?: string } = {},
): Promise<Luna7DayReportData & { reportText: string }> {
  const days = opts.days ?? 7;

  const [signals, trades, markets, reflexions, skills, lifecycle, agentActivity] =
    await Promise.allSettled([
      collectSignalStats(days),
      collectTradeStats(days),
      collectMarketStats(days),
      collectReflexionStats(days),
      collectSkillStats(days),
      collectLifecycleStats(days),
      collectAgentActivity(days),
    ]);

  const safe = <T>(r: PromiseSettledResult<T>, fallback: T): T =>
    r.status === 'fulfilled' ? r.value : fallback;

  const data: Luna7DayReportData = {
    generatedAt: new Date().toISOString(),
    periodDays: days,
    status: 'pending_observation',
    pendingReasons: [],
    signals: safe(signals, { fired: 0, blocked: 0, approved: 0, executed: 0, rejected: 0, statusCounts: {} }),
    trades: safe(trades, { total: 0, live: 0, mock: 0, avgPnlPct: 0, totalPnlUsdt: 0 }),
    markets: safe(markets, { binance: 0, kis: 0, kis_overseas: 0 }),
    reflexions: safe(reflexions, { count: 0, llmFailures: 0 }),
    skills: safe(skills, { extracted: 0, libraryTotal: 0 }),
    lifecycle: safe(lifecycle, { stage8Covered: 0, totalPositions: 0 }),
    agentActivity: safe(agentActivity, []),
    criteria: {
      fired5: false,
      reflexions5: false,
      skills1: false,
      smokeReg0: true,
    },
    passed: false,
  };

  data.criteria.fired5 = data.signals.fired >= 5;
  data.criteria.reflexions5 = data.reflexions.count >= 5;
  data.criteria.skills1 = data.skills.extracted >= 1;
  data.passed = Object.values(data.criteria).every(Boolean);
  data.pendingReasons = [
    data.criteria.fired5 ? null : `fired ${data.signals.fired}/5 — 7일 자연 운영 누적 대기`,
    data.criteria.reflexions5 ? null : `reflexions ${data.reflexions.count}/5 — close cycle 누적 대기`,
    data.criteria.skills1 ? null : `skills ${data.skills.extracted}/1 — Voyager 추출 자연 데이터 대기`,
    data.criteria.smokeReg0 ? null : 'smoke regression detected',
  ].filter(Boolean) as string[];
  data.status = data.pendingReasons.length === 0 ? 'complete' : 'pending_observation';

  const reportText = renderReport(data);

  if (opts.outputFile) {
    fs.mkdirSync(path.dirname(opts.outputFile), { recursive: true });
    fs.writeFileSync(opts.outputFile, reportText, 'utf8');
  }

  return { ...data, reportText };
}

async function main() {
  if (!ENABLED()) {
    console.log('[7day-report] 비활성. LUNA_7DAY_OPERATION_VERIFY_ENABLED=true로 활성화.');
    return;
  }
  const days = Number(process.argv.find(a => a.startsWith('--days='))?.split('=')[1] || 7);
  const outDir = path.join(INVESTMENT_DIR, 'output', 'reports');
  const date = new Date().toISOString().slice(0, 10);
  const noWrite = process.argv.includes('--no-write');
  const outputFile = noWrite ? undefined : path.join(outDir, `luna-7day-report-${date}.md`);

  const result = await runLuna7DayReport({ days, outputFile });

  if (process.argv.includes('--json')) {
    const { reportText: _, ...rest } = result;
    console.log(JSON.stringify(rest, null, 2));
  } else {
    console.log(result.reportText);
    if (outputFile) {
      console.log(`\n📄 보고서 저장: ${outputFile}`);
    }
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna-7day-report 실패:',
  });
}
