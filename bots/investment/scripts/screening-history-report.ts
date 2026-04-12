#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const marketArg = argv.find((arg) => arg.startsWith('--market='));
  const limitArg = argv.find((arg) => arg.startsWith('--limit='));
  return {
    market: marketArg ? marketArg.split('=')[1] : 'all',
    limit: Math.max(1, Number(limitArg?.split('=')[1] || 10)),
    json: argv.includes('--json'),
  };
}

function toKstString(value) {
  if (!value) return 'N/A';
  return new Date(value).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' });
}

function normalizeRows(rows = [], market = 'all') {
  return rows.map((row) => {
    const dynamic = Array.isArray(row.dynamic_symbols) ? row.dynamic_symbols : [];
    return {
      market: row.market || market,
      createdAt: row.created_at || null,
      dynamic,
      dynamicCount: dynamic.length,
      topSymbols: dynamic.slice(0, 5),
    };
  });
}

function buildSummary(rows = [], market = 'all') {
  const counts = new Map();
  const unique = new Set();

  for (const row of rows) {
    for (const symbol of row.dynamic || []) {
      unique.add(symbol);
      counts.set(symbol, (counts.get(symbol) || 0) + 1);
    }
  }

  const topSymbols = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, 10)
    .map(([symbol, count]) => ({ symbol, count }));

  return {
    market,
    totalRows: rows.length,
    uniqueDynamicSymbols: unique.size,
    topSymbols,
  };
}

async function loadRows(market, limit) {
  if (market === 'all') {
    return db.getRecentScreeningMarkets(limit);
  }
  return db.getRecentScreeningDynamicSymbols(market, limit);
}

function formatTextReport(summary, rows) {
  const lines = [
    `📋 screening_history 요약 — market=${summary.market}`,
    `행 수: ${summary.totalRows}`,
    `동적 종목 고유 수: ${summary.uniqueDynamicSymbols}`,
  ];

  if (summary.topSymbols.length > 0) {
    lines.push('상위 종목:');
    for (const item of summary.topSymbols) {
      lines.push(`  - ${item.symbol}: ${item.count}회`);
    }
  }

  if (rows.length > 0) {
    lines.push('최근 이력:');
    for (const row of rows) {
      lines.push(
        `  - ${toKstString(row.createdAt)} | ${row.market} | ${row.dynamicCount}개 | ${row.topSymbols.join(', ') || '없음'}`
      );
    }
  }

  return lines.join('\n');
}

export async function buildScreeningHistoryReport({ market = 'all', limit = 10, json = false } = {}) {
  const rows = normalizeRows(await loadRows(market, limit), market);
  const summary = buildSummary(rows, market);
  const payload = { summary, rows };

  if (json) return payload;
  return formatTextReport(summary, rows);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: async () => {
      await db.initSchema();
    },
    run: async () => {
      const args = parseArgs();
      const result = await buildScreeningHistoryReport(args);
      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(result);
      }
      return result;
    },
    onSuccess: async () => {},
    errorPrefix: '❌ screening-history-report 오류:',
  });
}
