// @ts-nocheck
/**
 * scripts/inspect-market-logs.js
 *
 * 목적:
 *   - Luna 통합 런타임 fresh 로그를 빠르게 요약
 *   - timeout, analyses/get 참조 오류, pg-pool 상태, 한울 단계 로그를 우선 표시
 *
 * 실행:
 *   node scripts/inspect-market-logs.js
 *   node scripts/inspect-market-logs.js --market=elixir
 *   node scripts/inspect-market-logs.js --tail=120
 */

import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const marketArg = args.find(a => a.startsWith('--market='))?.split('=')[1] || 'all';
const tail = Number(args.find(a => a.startsWith('--tail='))?.split('=')[1] || 80);
const freshMinutes = Number(args.find(a => a.startsWith('--fresh-minutes='))?.split('=')[1] || 360);
const maxReadBytes = Number(args.find(a => a.startsWith('--max-read-bytes='))?.split('=')[1] || 2_000_000);

const LOGS = {
  commander: {
    out: `${process.env.AI_AGENT_LOGS || `${process.env.HOME || ''}/.ai-agent-system/logs`}/luna-commander.log`,
    err: `${process.env.AI_AGENT_LOGS || `${process.env.HOME || ''}/.ai-agent-system/logs`}/luna-commander-error.log`,
    label: 'Luna commander',
  },
  marketdata: {
    out: '/tmp/ai.luna.marketdata-mcp.log',
    err: '/tmp/ai.luna.marketdata-mcp.err.log',
    label: 'Luna marketdata MCP',
  },
  tradingview: {
    out: '/tmp/ai.luna.tradingview-ws.log',
    err: '/tmp/ai.luna.tradingview-ws.err.log',
    label: 'Luna TradingView WS',
  },
  autopilot: {
    out: '/tmp/investment-runtime-autopilot.log',
    err: '/tmp/investment-runtime-autopilot.err.log',
    label: 'Luna runtime autopilot',
  },
  opsScheduler: {
    out: '/tmp/ai.luna.ops-scheduler.out.log',
    err: '/tmp/ai.luna.ops-scheduler.err.log',
    label: 'Luna ops scheduler',
  },
  elixir: {
    out: '/tmp/elixir-supervisor.log',
    err: '/tmp/elixir-supervisor.err',
    label: 'Luna Elixir supervisor',
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
  { key: 'kis_secret', label: 'KIS secret 누락', test: line => /(AppSecret은 필수|KIS .*app(secret|key).*미설정)/i.test(line) },
  { key: 'child_json', label: 'child JSON 파싱 실패', test: line => /child_output_not_json/i.test(line) },
];

const MARKET_ALIASES = {
  domestic: ['autopilot', 'opsScheduler', 'commander'],
  overseas: ['autopilot', 'opsScheduler', 'commander'],
  crypto: ['tradingview', 'autopilot', 'opsScheduler', 'commander'],
  runtime: ['autopilot', 'opsScheduler'],
};

function readLines(file) {
  try {
    const stat = fs.statSync(file);
    let text = '';
    if (stat.size > maxReadBytes) {
      const fd = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(maxReadBytes);
        fs.readSync(fd, buffer, 0, maxReadBytes, stat.size - maxReadBytes);
        text = buffer.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } else {
      text = fs.readFileSync(file, 'utf8');
    }
    return text.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function fileMtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function tailLines(lines, count) {
  return lines.slice(Math.max(0, lines.length - count));
}

function summarizeLog(name, config) {
  const outLines = readLines(config.out);
  const errLines = readLines(config.err);
  const errMtimeMs = fileMtimeMs(config.err);
  const errAgeMinutes = errMtimeMs == null ? null : Math.round((Date.now() - errMtimeMs) / 60000);
  const errFresh = errAgeMinutes == null || errAgeMinutes <= Math.max(1, freshMinutes);
  const errTail = errFresh ? tailLines(errLines, tail) : [];
  const merged = [...tailLines(outLines, tail), ...errTail];

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
    errFresh,
    errAgeMinutes,
    findings,
    recentOut: tailLines(outLines, 10),
    recentErr: errTail.slice(-10),
  };
}

function printSummary(summary) {
  console.log(`\n=== ${summary.label} ===`);
  console.log(`stdout: ${summary.outCount}줄 | stderr: ${summary.errCount}줄`);
  if (summary.errCount > 0 && summary.errFresh === false) {
    console.log(`stderr: stale (${summary.errAgeMinutes}분 전) — 현재 오류 판정에서 제외`);
  }

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
    : (MARKET_ALIASES[marketArg] || Object.keys(LOGS).filter(key => key === marketArg));

  if (markets.length === 0) {
    console.error(`알 수 없는 market: ${marketArg}`);
    process.exit(1);
  }

  for (const market of markets) {
    printSummary(summarizeLog(market, LOGS[market]));
  }
}

main();
