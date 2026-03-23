#!/usr/bin/env node
/**
 * scripts/force-exit-candidate-report.js
 *
 * 목적:
 *   - 장기 미결 LIVE 포지션을 시장별 threshold 기준으로 force-exit 후보로 정리
 *   - 아직 자동 청산 레일이 없더라도, 운영자가 동일 기준으로 우선순위를 판단할 수 있게 함
 *
 * 실행:
 *   node bots/investment/scripts/force-exit-candidate-report.js
 *   node bots/investment/scripts/force-exit-candidate-report.js --json
 */

import * as db from '../shared/db.js';

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
  };
}

function getMarketLabel(exchange) {
  if (exchange === 'kis') return '국내장';
  if (exchange === 'kis_overseas') return '해외장';
  return '암호화폐';
}

function getThresholdHours(exchange) {
  if (exchange === 'kis_overseas') return 72;
  if (exchange === 'kis') return 48;
  return 48;
}

function getCandidateLevel(exchange, ageHours) {
  const threshold = getThresholdHours(exchange);
  if (ageHours >= threshold * 2) return 'strong_force_exit_candidate';
  return 'force_exit_candidate';
}

function getPriorityScore(row) {
  const ageHours = Number(row.ageHours ?? row.age_hours ?? 0);
  const value = Number(row.positionValue ?? row.position_value ?? 0);
  const threshold = getThresholdHours(row.exchange);
  const ageFactor = ageHours / Math.max(1, threshold);
  const valueFactor = Math.log10(Math.max(1, value));
  return Number((ageFactor * 100 + valueFactor * 10).toFixed(2));
}

function buildSummary(rows) {
  const perExchange = new Map();
  for (const row of rows) {
    const exchange = row.exchange;
    const bucket = perExchange.get(exchange) || { count: 0, grossValue: 0 };
    bucket.count += 1;
    bucket.grossValue += Number(row.positionValue ?? row.position_value ?? 0);
    perExchange.set(exchange, bucket);
  }

  return [...perExchange.entries()]
    .map(([exchange, value]) => ({
      exchange,
      marketLabel: getMarketLabel(exchange),
      count: value.count,
      grossValue: Number(value.grossValue.toFixed(2)),
      thresholdHours: getThresholdHours(exchange),
    }))
    .sort((a, b) => b.count - a.count || b.grossValue - a.grossValue);
}

function formatHuman(report) {
  const lines = [];
  lines.push('🧹 투자팀 force-exit 후보 리포트');
  lines.push('');
  lines.push(`- 총 후보: ${report.totalCandidates}건`);
  lines.push(`- strong 후보: ${report.strongCandidates}건`);
  lines.push('');
  lines.push('시장별 요약:');
  if (report.summary.length === 0) {
    lines.push('- 장기 미결 LIVE 후보 없음');
  } else {
    for (const item of report.summary) {
      lines.push(`- ${item.marketLabel}: ${item.count}건 / value ${item.grossValue.toFixed(2)} / threshold ${item.thresholdHours}h`);
    }
  }
  lines.push('');
  lines.push('후보 상세:');
  if (report.candidates.length === 0) {
    lines.push('- 없음');
  } else {
    for (const row of report.candidates) {
      lines.push(`- ${getMarketLabel(row.exchange)} ${row.symbol} | ${row.candidateLevel} | ${row.ageHours.toFixed(1)}h | value ${row.positionValue.toFixed(2)} | priority ${row.priorityScore}`);
    }
  }
  return lines.join('\n');
}

async function ensureReadableInvestmentSchema() {
  try {
    await db.initSchema();
  } catch (error) {
    const text = `${error?.stack || error?.message || error || ''}`;
    // Read-only 보고 스크립트는 sandbox/ops 제약으로 initSchema가 막혀도
    // 기존 스키마가 이미 있으면 query만으로 동작할 수 있어야 한다.
    if (text.includes('EPERM')) {
      return;
    }
    throw error;
  }
}

async function loadCandidates() {
  await ensureReadableInvestmentSchema();
  const rows = await db.query(`
    SELECT
      exchange,
      symbol,
      paper,
      COALESCE(trade_mode, 'normal') AS trade_mode,
      amount,
      avg_price,
      updated_at,
      ROUND((amount * avg_price)::numeric, 2) AS position_value,
      ROUND(EXTRACT(EPOCH FROM (NOW() - updated_at))/3600::numeric, 1) AS age_hours
    FROM positions
    WHERE amount > 0
      AND paper = false
    ORDER BY updated_at ASC
  `);

  return rows
    .map((row) => {
      const ageHours = Number(row.age_hours || 0);
      const thresholdHours = getThresholdHours(row.exchange);
      const candidate = ageHours >= thresholdHours;
      return {
        exchange: row.exchange,
        symbol: row.symbol,
        tradeMode: row.trade_mode,
        amount: Number(row.amount || 0),
        avgPrice: Number(row.avg_price || 0),
        positionValue: Number(row.position_value || 0),
        ageHours,
        updatedAt: row.updated_at,
        thresholdHours,
        candidate,
        candidateLevel: candidate ? getCandidateLevel(row.exchange, ageHours) : null,
      };
    })
    .filter((row) => row.candidate)
    .map((row) => ({
      ...row,
      priorityScore: getPriorityScore({ ...row, exchange: row.exchange }),
    }))
    .sort((a, b) => b.priorityScore - a.priorityScore || b.ageHours - a.ageHours || b.positionValue - a.positionValue);
}

async function main() {
  const options = parseArgs();
  const candidates = await loadCandidates();
  const report = {
    generatedAt: new Date().toISOString(),
    totalCandidates: candidates.length,
    strongCandidates: candidates.filter((row) => row.candidateLevel === 'strong_force_exit_candidate').length,
    summary: buildSummary(candidates),
    candidates,
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(formatHuman(report));
}

main().catch((error) => {
  console.error(`[force-exit-candidate-report] ${error?.stack || error?.message || String(error)}`);
  process.exit(1);
});
