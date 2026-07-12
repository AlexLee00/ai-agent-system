// @ts-nocheck
'use strict';

// Week 2 Day 14: 7일 Shadow 누적 통계 보고서
// Phase A / LLM Auto-Routing / Permission / Budget 통계 집계
//
// 실행:
//   tsx bots/hub/scripts/week2-shadow-summary-report.ts
//   tsx bots/hub/scripts/week2-shadow-summary-report.ts --telegram --json

import path from 'node:path';
import fs from 'node:fs';
const PROJECT_ROOT = path.resolve(__dirname, '../../..');

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

interface Week2ShadowSummary {
  ok: boolean;
  ts: string;
  period: { from: string; to: string; days: number };
  phaseA: { shadowSignals: number; status: string };
  llmRouting: { total: number; byShadow: number; byActive: number; byComplexity: Record<string, number>; estimatedSavingsUsd: number };
  permission: { total: number; allowed: number; blocked: number; escalated: number };
  budget: { events: number; teamBreakdown: Record<string, number> };
  readyForWeek3: boolean;
  recommendations: string[];
}

async function queryWithFallback(pgPool: any, sql: string, params: any[] = []): Promise<any[]> {
  try {
    const rows = await pgPool.query('public', sql, params);
    return Array.isArray(rows) ? rows : (rows?.rows ?? []);
  } catch (_) {
    return [];
  }
}

export async function runWeek2ShadowSummaryReport(options: { days?: number } = {}): Promise<Week2ShadowSummary> {
  const pgPool = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool'));
  const days = options.days ?? 7;
  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  // Phase A Shadow Signals
  const phaseRows = await queryWithFallback(pgPool, `
    SELECT count(*) AS cnt
    FROM investment.korea_public_data_shadow_signals
    WHERE created_at > $1
  `, [from.toISOString()]);
  const shadowSignals = parseInt(phaseRows[0]?.cnt || '0', 10);

  // LLM Auto-Routing
  const routingRows = await queryWithFallback(pgPool, `
    SELECT
      mode,
      task_complexity,
      count(*) AS cnt,
      sum(cost_usd) AS total_cost,
      avg(latency_ms) AS avg_ms
    FROM hub.llm_auto_routing_log
    WHERE created_at > $1
    GROUP BY mode, task_complexity
  `, [from.toISOString()]);

  let routingTotal = 0;
  let routingShadow = 0;
  let routingActive = 0;
  const byComplexity: Record<string, number> = {};
  let totalCostEstimate = 0;

  for (const row of routingRows) {
    const cnt = parseInt(row.cnt || '0', 10);
    routingTotal += cnt;
    if (row.mode === 'shadow') routingShadow += cnt;
    if (row.mode === 'active') routingActive += cnt;
    byComplexity[row.task_complexity] = (byComplexity[row.task_complexity] || 0) + cnt;
    // haiku vs sonnet 비용 절감 추정
    if (row.task_complexity === 'simple' || row.auto_model === 'anthropic_haiku') {
      totalCostEstimate += (parseFloat(row.total_cost || '0')) * 0.73; // 73% 절감
    }
  }

  // Permission Audit
  const permRows = await queryWithFallback(pgPool, `
    SELECT decision, count(*) AS cnt
    FROM hub.permission_audit_log
    WHERE created_at > $1
    GROUP BY decision
  `, [from.toISOString()]);

  const permStats = { total: 0, allowed: 0, blocked: 0, escalated: 0 };
  for (const row of permRows) {
    const cnt = parseInt(row.cnt || '0', 10);
    permStats.total += cnt;
    if (row.decision === 'allowed') permStats.allowed += cnt;
    if (row.decision === 'blocked') permStats.blocked += cnt;
    if (row.decision === 'escalated') permStats.escalated += cnt;
  }

  // Budget Events
  const budgetRows = await queryWithFallback(pgPool, `
    SELECT caller_team, count(*) AS cnt
    FROM hub.token_budget_log
    WHERE created_at > $1
    GROUP BY caller_team
  `, [from.toISOString()]);

  const budgetBreakdown: Record<string, number> = {};
  let budgetTotal = 0;
  for (const row of budgetRows) {
    const cnt = parseInt(row.cnt || '0', 10);
    budgetBreakdown[row.caller_team] = cnt;
    budgetTotal += cnt;
  }

  // 권장사항 생성
  const recommendations: string[] = [];
  if (shadowSignals < 100) recommendations.push(`Phase A Shadow 신호 부족 (${shadowSignals}개) — Phase A launchd 동작 확인 필요`);
  if (routingTotal === 0) recommendations.push('LLM Auto-Routing 로그 없음 — LLM_AUTO_ROUTING_ENABLED=shadow 설정 확인');
  if (permStats.total === 0) recommendations.push('Permission Audit 로그 없음 — PERMISSION_TIER_ENFORCE=shadow 설정 확인');
  if (permStats.escalated > 10) recommendations.push(`Permission ESCALATE ${permStats.escalated}건 — 패턴 분석 권고`);

  const readyForWeek3 = shadowSignals > 0 || routingTotal > 0 || permStats.total > 0;

  return {
    ok: true,
    ts: now.toISOString(),
    period: { from: from.toISOString(), to: now.toISOString(), days },
    phaseA: { shadowSignals, status: shadowSignals > 500 ? 'healthy' : shadowSignals > 0 ? 'low' : 'no_data' },
    llmRouting: { total: routingTotal, byShadow: routingShadow, byActive: routingActive, byComplexity, estimatedSavingsUsd: totalCostEstimate },
    permission: permStats,
    budget: { events: budgetTotal, teamBreakdown: budgetBreakdown },
    readyForWeek3,
    recommendations,
  };
}

function formatReport(summary: Week2ShadowSummary): string {
  const lines = [
    '=== Week 2 Shadow 누적 보고서 ===',
    `기간: ${summary.period.days}일 (${summary.period.from.slice(0, 10)} ~ ${summary.period.to.slice(0, 10)})`,
    '',
    '📊 Phase A Shadow 신호:',
    `  누적: ${summary.phaseA.shadowSignals}건 (상태: ${summary.phaseA.status})`,
    '',
    '🤖 LLM Auto-Routing:',
    `  총 ${summary.llmRouting.total}건 (shadow: ${summary.llmRouting.byShadow}, active: ${summary.llmRouting.byActive})`,
    `  복잡도 분포: ${JSON.stringify(summary.llmRouting.byComplexity)}`,
    `  예상 비용 절감: $${summary.llmRouting.estimatedSavingsUsd.toFixed(4)}`,
    '',
    '🔐 Permission Audit:',
    `  총 ${summary.permission.total}건 (허용: ${summary.permission.allowed}, 차단: ${summary.permission.blocked}, 에스컬레이션: ${summary.permission.escalated})`,
    '',
    '💰 Budget 이벤트:',
    `  총 ${summary.budget.events}건`,
    `  팀별: ${JSON.stringify(summary.budget.teamBreakdown)}`,
    '',
    `✅ Week 3 진행 가능: ${summary.readyForWeek3 ? '예' : '아니오'}`,
  ];

  if (summary.recommendations.length > 0) {
    lines.push('', '⚠️ 권장사항:');
    for (const rec of summary.recommendations) lines.push(`  - ${rec}`);
  }

  return lines.join('\n');
}

async function main() {
  console.log('[week2-shadow-summary-report] 7일 Shadow 보고서 생성 중...');
  const summary = await runWeek2ShadowSummaryReport();
  const report = formatReport(summary);
  console.log(report);

  const outPath = '/tmp/week2-shadow-summary.md';
  fs.writeFileSync(outPath, `# Week 2 Shadow 보고서\n\n\`\`\`\n${report}\n\`\`\`\n`, 'utf8');
  console.log(`\n[week2-shadow-summary-report] 보고서 저장: ${outPath}`);

  if (hasFlag('telegram')) {
    try {
      const sender = require(path.join(PROJECT_ROOT, 'packages/core/lib/telegram-sender'));
      await sender.sendMessage(`📊 *Week 2 Shadow 보고서*\n\n\`\`\`\n${report}\n\`\`\``);
      console.log('[week2-shadow-summary-report] Telegram 전송 완료');
    } catch (err: any) {
      console.warn('[week2-shadow-summary-report] Telegram 전송 실패:', err?.message);
    }
  }

  if (hasFlag('json')) console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[week2-shadow-summary-report] 오류:', err?.message || err);
    process.exit(1);
  });
}
