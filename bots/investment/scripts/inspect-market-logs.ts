// @ts-nocheck
/**
 * scripts/inspect-market-logs.js
 *
 * 목적:
 *   - 국내장/해외장 fresh 로그를 빠르게 요약
 *   - timeout, analyses/get 참조 오류, pg-pool 상태, 한울 단계 로그를 우선 표시
 *
 * 실행:
 *   node scripts/inspect-market-logs.js
 *   node scripts/inspect-market-logs.js --market=domestic
 *   node scripts/inspect-market-logs.js --tail=120
 */

import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const marketArg = args.find(a => a.startsWith('--market='))?.split('=')[1] || 'all';
const tail = Number(args.find(a => a.startsWith('--tail='))?.split('=')[1] || 80);

const LOGS = {
  domestic: {
    out: '/tmp/investment-domestic.log',
    err: '/tmp/investment-domestic.err.log',
    label: '국내장',
  },
  overseas: {
    out: '/tmp/investment-overseas.log',
    err: '/tmp/investment-overseas.err.log',
    label: '해외장',
  },
};

const KEY_PATTERNS = [
  { key: 'db_timeout', label: 'DB timeout', test: line => /Connection terminated due to connection timeout/i.test(line) },
  { key: 'analyses_ref', label: 'analyses 참조 오류', test: line => /analyses is not defined/i.test(line) },
  { key: 'get_ref', label: 'get 참조 오류', test: line => /get is not defined/i.test(line) },
  { key: 'pg_pool', label: 'pg-pool 로그', test: line => /\[pg-pool:/i.test(line) },
  { key: 'hanul_phase', label: '한울 단계 로그', test: line => /\[한울\].*(조회|처리 완료|전체 처리 완료)/i.test(line) },
  { key: 'screening_fail', label: '스크리닝 실패', test: line => /(스크리닝 전체 실패|거래량 순위 조회 실패|시세 API 실패)/i.test(line) },
  { key: 'llm_timeout', label: 'LLM timeout', test: line => /Request timed out/i.test(line) },
];

function readLines(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function tailLines(lines, count) {
  return lines.slice(Math.max(0, lines.length - count));
}

function summarizeLog(name, config) {
  const outLines = readLines(config.out);
  const errLines = readLines(config.err);
  const merged = [...tailLines(outLines, tail), ...tailLines(errLines, tail)];

  const findings = KEY_PATTERNS.map(pattern => {
    const matches = merged.filter(line => pattern.test(line));
    return {
      ...pattern,
      count: matches.length,
      samples: matches.slice(-3),
    };
  }).filter(item => item.count > 0);

  return {
    name,
    label: config.label,
    outCount: outLines.length,
    errCount: errLines.length,
    findings,
    recentOut: tailLines(outLines, 10),
    recentErr: tailLines(errLines, 10),
  };
}

function printSummary(summary) {
  console.log(`\n=== ${summary.label} ===`);
  console.log(`stdout: ${summary.outCount}줄 | stderr: ${summary.errCount}줄`);

  if (summary.findings.length === 0) {
    console.log('핵심 패턴 없음');
  } else {
    for (const finding of summary.findings) {
      console.log(`- ${finding.label}: ${finding.count}건`);
      for (const sample of finding.samples) {
        console.log(`  ${sample}`);
      }
    }
  }

  if (summary.recentErr.length > 0) {
    console.log('\n최근 stderr:');
    for (const line of summary.recentErr) console.log(`  ${line}`);
  } else if (summary.recentOut.length > 0) {
    console.log('\n최근 stdout:');
    for (const line of summary.recentOut) console.log(`  ${line}`);
  }
}

function main() {
  const markets = marketArg === 'all'
    ? Object.keys(LOGS)
    : Object.keys(LOGS).filter(key => key === marketArg);

  if (markets.length === 0) {
    console.error(`알 수 없는 market: ${marketArg}`);
    process.exit(1);
  }

  for (const market of markets) {
    printSummary(summarizeLog(market, LOGS[market]));
  }
}

main();
