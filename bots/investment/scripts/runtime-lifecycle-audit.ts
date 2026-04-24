#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { auditPhase6Coverage, LIFECYCLE_PHASES } from '../shared/lifecycle-contract.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const args = { days: 7, json: false };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw.startsWith('--days=')) args.days = Math.max(1, Number(raw.split('=')[1] || 7));
  }
  return args;
}

async function buildLifecycleAuditReport({ days = 7 } = {}) {
  await db.initSchema();

  const [coverage, phase6Audit] = await Promise.all([
    db.getLifecyclePhaseCoverage({ days }),
    auditPhase6Coverage({ days }),
  ]);

  const phaseStats = {};
  for (const phase of LIFECYCLE_PHASES) {
    const covered = coverage.filter((r) => Array.isArray(r.covered_phases) && r.covered_phases.includes(phase));
    phaseStats[phase] = {
      coveredPositions: covered.length,
      totalEvents: covered.reduce((sum, r) => sum + Number(r.event_count || 0), 0),
    };
  }

  const phase6CoverageRate = phase6Audit.total > 0
    ? Number(((phase6Audit.covered / phase6Audit.total) * 100).toFixed(1))
    : null;

  const warnings = [];
  if (phase6Audit.gaps.length > 0) {
    warnings.push(`phase6_gap: ${phase6Audit.gaps.length}개 ADJUST/EXIT 후보에 lifecycle event 없음`);
    for (const g of phase6Audit.gaps.slice(0, 5)) {
      warnings.push(`  - ${g.symbol} ${g.exchange} ${g.tradeMode} → ${g.recommendation}`);
    }
  }
  if (phaseStats.phase6_closeout?.coveredPositions === 0) {
    warnings.push('phase6_closeout: 최근 이벤트 없음. partial-adjust/strategy-exit 실행 후 확인 필요');
  }

  return {
    ok: true,
    days,
    generatedAt: new Date().toISOString(),
    phaseStats,
    phase6Coverage: {
      total: phase6Audit.total,
      covered: phase6Audit.covered,
      coverageRatePct: phase6CoverageRate,
      gaps: phase6Audit.gaps,
    },
    positionsCovered: coverage.length,
    warnings,
  };
}

function renderText(payload) {
  const lines = [
    '🔍 Lifecycle Audit',
    `period: ${payload.days}d | positions w/ events: ${payload.positionsCovered}`,
    '',
    '단계별 커버리지:',
  ];
  for (const [phase, stat] of Object.entries(payload.phaseStats)) {
    lines.push(`  ${phase}: positions=${stat.coveredPositions}, events=${stat.totalEvents}`);
  }
  lines.push('');
  const p6 = payload.phase6Coverage;
  lines.push(`phase6 gap 감사: total=${p6.total}, covered=${p6.covered}, rate=${p6.coverageRatePct ?? 'n/a'}%`);
  if (p6.gaps.length > 0) {
    lines.push('  gaps:');
    for (const g of p6.gaps.slice(0, 10)) {
      lines.push(`  - ${g.symbol} ${g.exchange} ${g.tradeMode} → ${g.recommendation}`);
    }
  }
  if (payload.warnings.length > 0) {
    lines.push('');
    lines.push('경고:');
    for (const w of payload.warnings) lines.push(`  ⚠️  ${w}`);
  } else {
    lines.push('✅ 경고 없음');
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs();
  const payload = await buildLifecycleAuditReport(args);
  if (args.json) console.log(JSON.stringify(payload, null, 2));
  else console.log(renderText(payload));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: () => db.initSchema(),
    run: main,
    errorPrefix: '❌ runtime-lifecycle-audit 오류:',
  });
}

export { buildLifecycleAuditReport };
