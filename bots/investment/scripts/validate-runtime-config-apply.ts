#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/validate-runtime-config-apply.js
 *
 * 승인/적용된 runtime_config 제안의 현재 상태를 검증한다.
 * - suggestion log 상태
 * - 최근 N일 시장별 신호 요약
 * - 투자팀 health-report 결과
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'os';
import { join } from 'path';
import * as db from '../shared/db.ts';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = process.env.PROJECT_ROOT || join(homedir(), 'projects', 'ai-agent-system');

function parseArgs(argv = process.argv.slice(2)) {
  return {
    id: argv.find(arg => arg.startsWith('--id='))?.split('=')[1] || null,
    days: Math.max(1, Number(argv.find(arg => arg.startsWith('--days='))?.split('=')[1] || 7)),
    json: argv.includes('--json'),
  };
}

function buildDateRange(days) {
  const to = new Date();
  const from = new Date(Date.now() - (days - 1) * 86400000);
  const toDate = to.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const fromDate = from.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  return { fromDate, toDate };
}

function summarizeExchange(rows, exchange) {
  const hit = rows.filter(row => row.exchange === exchange);
  const buy = hit.filter(row => row.action === 'BUY').reduce((sum, row) => sum + Number(row.cnt || 0), 0);
  const executed = hit.filter(row => row.status === 'executed').reduce((sum, row) => sum + Number(row.cnt || 0), 0);
  const failed = hit
    .filter(row => ['failed', 'rejected', 'expired'].includes(row.status))
    .reduce((sum, row) => sum + Number(row.cnt || 0), 0);
  return {
    exchange,
    buy,
    executed,
    failed,
    executionRate: buy > 0 ? Math.round((executed / buy) * 1000) / 10 : 0,
  };
}

async function loadRecentSignalSummary(days) {
  const { fromDate, toDate } = buildDateRange(days);
  const rows = await db.query(`
    SELECT exchange, action, status, COUNT(*) AS cnt
    FROM signals
    WHERE CAST(created_at AT TIME ZONE 'Asia/Seoul' AS DATE) BETWEEN '${fromDate}' AND '${toDate}'
    GROUP BY exchange, action, status
    ORDER BY exchange, action, status
  `);
  return {
    fromDate,
    toDate,
    exchanges: {
      binance: summarizeExchange(rows, 'binance'),
      kis: summarizeExchange(rows, 'kis'),
      kis_overseas: summarizeExchange(rows, 'kis_overseas'),
    },
  };
}

async function loadInvestmentHealth() {
  try {
    const result = await Promise.race([
      execFileAsync('node', [
        join(PROJECT_ROOT, 'bots/investment/scripts/health-report.js'),
        '--json',
      ], {
        cwd: PROJECT_ROOT,
        maxBuffer: 1024 * 1024,
      }),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('health-report timeout')), 5000);
      }),
    ]);
    const { stdout } = result;
    const raw = String(stdout || '').trim();
    if (!raw.includes('{')) {
      throw new Error('health-report JSON output missing');
    }
    const jsonText = raw.slice(raw.indexOf('{'));
    return JSON.parse(jsonText);
  } catch (error) {
    return {
      error: error?.message || String(error),
    };
  }
}

function buildDecision(logRow, health, signalSummary) {
  const warnings = [];
  if (!logRow) {
    warnings.push('제안 로그를 찾을 수 없습니다.');
  } else if (logRow.review_status !== 'applied') {
    warnings.push(`현재 제안 상태가 ${logRow.review_status} 입니다. 적용 후 검증 단계로 보기 어렵습니다.`);
  }

  if (health?.serviceHealth?.warnCount > 0) {
    warnings.push(`투자팀 health 경고 ${health.serviceHealth.warnCount}건이 있어 설정 효과보다 운영 안정성 점검이 우선입니다.`);
  }

  const crypto = signalSummary?.exchanges?.binance;
  if (crypto && crypto.buy > 0 && crypto.executed === 0) {
    warnings.push(`최근 ${signalSummary.fromDate}~${signalSummary.toDate} 암호화폐 BUY ${crypto.buy}건 중 실행이 0건입니다.`);
  }

  if (warnings.length > 0) {
    return {
      stage: 'observe',
      recommendation: '운영 관찰 유지',
      reasons: warnings,
    };
  }

  return {
    stage: 'stable',
    recommendation: '다음 제안 전까지 유지',
    reasons: ['제안 상태와 health, 최근 실행 흐름이 모두 검증 가능한 범위에 있습니다.'],
  };
}

function printHuman(report) {
  const lines = [
    `🧪 투자 runtime_config 적용 검증 (${report.days}일)`,
    '',
    '제안 상태:',
    `- id: ${report.suggestion?.id || '-'}`,
    `- status: ${report.suggestion?.review_status || '-'}`,
    `- reviewed_at: ${report.suggestion?.reviewed_at || '-'}`,
    `- applied_at: ${report.suggestion?.applied_at || '-'}`,
    '',
    '최근 시장 요약:',
  ];

  for (const item of Object.values(report.signalSummary.exchanges)) {
    lines.push(`- ${item.exchange}: BUY ${item.buy}건 / 실행 ${item.executed}건 / 실패 ${item.failed}건 / 실행률 ${item.executionRate}%`);
  }

  lines.push('');
  lines.push('health 상태:');
  if (report.health.error) {
    lines.push(`- health-report 실패: ${report.health.error}`);
  } else {
    lines.push(`- warnCount: ${report.health.serviceHealth?.warnCount ?? 0}`);
    lines.push(`- decision: ${report.health.decision?.level || '-'}`);
  }

  lines.push('');
  lines.push('검증 판단:');
  lines.push(`- stage: ${report.decision.stage}`);
  lines.push(`- recommendation: ${report.decision.recommendation}`);
  for (const reason of report.decision.reasons) {
    lines.push(`- reason: ${reason}`);
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main() {
  const { id, days, json } = parseArgs();
  if (!id) throw new Error('`--id=<suggestion_log_id>`가 필요합니다.');

  await db.initSchema();
  const [suggestion, signalSummary, health] = await Promise.all([
    db.getRuntimeConfigSuggestionLogById(id),
    loadRecentSignalSummary(days),
    loadInvestmentHealth(),
  ]);

  const report = {
    days,
    suggestion,
    signalSummary,
    health,
    decision: buildDecision(suggestion, health, signalSummary),
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  printHuman(report);
}

main().catch((error) => {
  process.stderr.write(`❌ ${error?.stack || error?.message || String(error)}\n`);
  process.exit(1);
});
