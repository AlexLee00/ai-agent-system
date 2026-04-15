#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildRemodelCloseoutReport } from './remodel-closeout-report.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  return {
    days: Math.max(7, Number(daysArg?.split('=')[1] || 14)),
    json: argv.includes('--json'),
  };
}

function normalizeHealthRows(health) {
  const rows = health?.serviceHealth?.rows;
  if (Array.isArray(rows)) {
    return rows
      .filter((row) => row?.status && row.status !== 'ok')
      .map((row) => ({
        label: row.label || row.name || row.service || 'unknown',
        status: row.status,
        detail: row.detail || row.message || row.summary || row.status,
      }));
  }

  if (rows && typeof rows === 'object') {
    if (Array.isArray(rows.warn)) {
      return rows.warn.map((line) => ({
        label: String(line).trimStart().split(':')[0] || 'unknown',
        status: 'warn',
        detail: String(line).trim(),
      }));
    }
    if (Array.isArray(rows.ok) && Number(health?.serviceHealth?.warnCount || 0) > 0) {
      return [{
        label: 'serviceHealth',
        status: 'warn',
        detail: `warnCount=${Number(health?.serviceHealth?.warnCount || 0)}`,
      }];
    }
  }

  const warn = health?.serviceHealth?.warn;
  if (Array.isArray(warn)) {
    return warn.map((line) => ({
      label: String(line).trimStart().split(':')[0] || 'unknown',
      status: 'warn',
      detail: String(line).trim(),
    }));
  }

  return [];
}

function buildPlannerCoverageBlockers(plannerCoverage) {
  const rows = plannerCoverage?.rows || [];
  return rows
    .filter((row) => Number(row?.missing || 0) > 0)
    .map((row) => ({
      market: row.market,
      label: row.label,
      ratio: Number(row.ratio || 0),
      attached: Number(row.attached || 0),
      count: Number(row.count || 0),
      detail: `${row.label} planner attach ${row.attached}/${row.count} (${Math.round(Number(row.ratio || 0) * 100)}%)`,
    }));
}

function buildBlockers(closeout) {
  const blockers = [];
  const decision = closeout?.decision || {};
  const metrics = decision.metrics || {};

  const healthRows = normalizeHealthRows(closeout?.health);
  if (!metrics.healthOk) {
    const healthCountDetail = {
      label: 'health_counts',
      status: 'blocked',
      detail: `ok=${Number(closeout?.health?.serviceHealth?.okCount || 0)}, warn=${Number(closeout?.health?.serviceHealth?.warnCount || 0)}`,
    };
    blockers.push({
      category: 'health',
      status: 'blocked',
      summary: '운영 health 기준선이 아직 닫히지 않았습니다.',
      details: [healthCountDetail, ...healthRows],
    });
  }

  const plannerRows = buildPlannerCoverageBlockers(closeout?.plannerCoverage);
  if (!metrics.plannerReady || plannerRows.some((row) => row.ratio < 1)) {
    blockers.push({
      category: 'planner_coverage',
      status: metrics.plannerReady ? 'observe' : 'blocked',
      summary: metrics.plannerReady
        ? 'planner attach는 시작됐지만 시장별 coverage가 아직 균등하지 않습니다.'
        : 'planner attach coverage가 아직 준비되지 않았습니다.',
      details: plannerRows,
    });
  }

  if (metrics.autotuneBlocked) {
    blockers.push({
      category: 'autotune',
      status: 'blocked',
      summary: closeout?.autotune?.decision?.headline || 'autotune readiness가 아직 막혀 있습니다.',
      details: (closeout?.autotune?.decision?.reasons || []).map((reason) => ({
        label: 'reason',
        status: 'blocked',
        detail: reason,
      })),
    });
  }

  if (metrics.reliefBlocked) {
    const reliefMetrics = closeout?.relief?.decision?.metrics || {};
    blockers.push({
      category: 'min_order_relief',
      status: 'blocked',
      summary: closeout?.relief?.decision?.headline || '최소 주문 병목 완화가 아직 구조적으로 막혀 있습니다.',
      details: [
        {
          label: 'attempted',
          status: 'blocked',
          detail: `${Number(reliefMetrics.attempted || 0).toLocaleString()} KRW`,
        },
        {
          label: 'required',
          status: 'blocked',
          detail: `${Number(reliefMetrics.required || 0).toLocaleString()} KRW`,
        },
        {
          label: 'gap',
          status: 'blocked',
          detail: `${Number(reliefMetrics.gap || 0).toLocaleString()} KRW`,
        },
      ],
    });
  }

  if (metrics.escalateBlocked) {
    blockers.push({
      category: 'escalate',
      status: 'approval_needed',
      summary: closeout?.escalate?.decision?.headline || '운영 승인/정책 결정이 필요한 항목이 남아 있습니다.',
      details: (closeout?.escalate?.rows || []).map((row) => ({
        label: row.key || 'candidate',
        status: row.blockedByPolicy ? 'policy_blocked' : 'approval_needed',
        detail: row.reason || row.summary || '승인 필요',
      })),
    });
  }

  return blockers;
}

function buildDecision(blockers = []) {
  if (blockers.length === 0) {
    return {
      status: 'no_blockers',
      headline: 'closeout을 막는 추가 blocker가 보이지 않습니다.',
      actionItems: [],
    };
  }

  const healthBlocked = blockers.some((blocker) => blocker.category === 'health');
  const escalateBlocked = blockers.some((blocker) => blocker.category === 'escalate');
  const reliefBlocked = blockers.some((blocker) => blocker.category === 'min_order_relief');

  const status = healthBlocked
    ? 'health_blockers_present'
    : escalateBlocked || reliefBlocked
      ? 'policy_blockers_present'
      : 'coverage_observe';

  const actionItems = [];
  if (healthBlocked) actionItems.push('health warn 서비스를 먼저 정리해 closeout 기준선을 회복합니다.');
  if (reliefBlocked) actionItems.push('국내장 최소 주문 병목은 order cap 재설계 또는 예외 전략 분리가 필요합니다.');
  if (escalateBlocked) actionItems.push('승인 필요 항목을 운영 정책 검토 안건으로 승격합니다.');

  return {
    status,
    headline: `closeout blocker ${blockers.length}건이 남아 있습니다.`,
    actionItems,
  };
}

function renderText(payload) {
  return [
    '🚧 Luna Remodel Blockers',
    `status: ${payload.decision.status}`,
    `headline: ${payload.decision.headline}`,
    '',
    'blockers:',
    ...payload.blockers.flatMap((blocker) => [
      `- ${blocker.category}: ${blocker.summary}`,
      ...blocker.details.slice(0, 5).map((detail) => `  • ${detail.label}: ${detail.detail}`),
    ]),
    '',
    'actionItems:',
    ...payload.decision.actionItems.map((item) => `- ${item}`),
  ].join('\n');
}

export async function buildRemodelBlockersReport({ days = 14, json = false } = {}) {
  const closeout = await buildRemodelCloseoutReport({ days, json: true });
  const blockers = buildBlockers(closeout);
  const decision = buildDecision(blockers);
  const payload = {
    ok: true,
    days,
    blockers,
    decision,
    closeoutStatus: closeout?.decision?.status || null,
  };
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRemodelBlockersReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ remodel-blockers-report 오류:',
  });
}
