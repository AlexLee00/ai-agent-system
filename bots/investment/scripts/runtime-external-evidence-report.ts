#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { buildEvidenceSummaryForAgent } from '../shared/external-evidence-ledger.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const args = { days: 7, json: false, symbol: null };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    if (raw.startsWith('--days=')) args.days = Math.max(1, Number(raw.split('=')[1] || 7));
    if (raw.startsWith('--symbol=')) args.symbol = raw.split('=').slice(1).join('=').toUpperCase();
  }
  return args;
}

async function buildReport({ days = 7 } = {}) {
  await db.initSchema();

  const allRows = await db.query(`
    SELECT source_type,
           COUNT(*) AS count,
           ROUND(AVG(source_quality)::numeric, 3) AS avg_quality,
           ROUND(AVG(freshness_score)::numeric, 3) AS avg_freshness,
           COUNT(*) FILTER (WHERE signal_direction = 'bullish') AS bullish,
           COUNT(*) FILTER (WHERE signal_direction = 'bearish') AS bearish,
           MAX(created_at) AS latest_at
    FROM investment.external_evidence_events
    WHERE created_at >= now() - ($1::int * INTERVAL '1 day')
    GROUP BY 1
    ORDER BY count DESC
  `, [days]).catch(() => []);

  const symbolRows = await db.query(`
    SELECT symbol, COUNT(*) AS count,
           ROUND(AVG(source_quality)::numeric, 3) AS avg_quality,
           STRING_AGG(DISTINCT signal_direction, ', ' ORDER BY signal_direction) AS directions,
           MAX(created_at) AS latest_at
    FROM investment.external_evidence_events
    WHERE created_at >= now() - ($1::int * INTERVAL '1 day')
      AND symbol IS NOT NULL
    GROUP BY 1
    ORDER BY count DESC
    LIMIT 20
  `, [days]).catch(() => []);

  const totalCount = allRows.reduce((s, r) => s + Number(r.count || 0), 0);
  const avgQuality = allRows.length > 0
    ? Number((allRows.reduce((s, r) => s + Number(r.avg_quality || 0) * Number(r.count || 0), 0) / Math.max(totalCount, 1)).toFixed(3))
    : 0;

  return {
    ok: true,
    days,
    generatedAt: new Date().toISOString(),
    totalCount,
    avgQuality,
    bySourceType: allRows,
    bySymbol: symbolRows,
  };
}

function renderText(payload) {
  const lines = [
    '📊 External Evidence Ledger 리포트',
    `period: ${payload.days}d | total: ${payload.totalCount} | avgQuality: ${payload.avgQuality}`,
    '',
    'source별:',
  ];
  for (const r of payload.bySourceType) {
    lines.push(`  ${r.source_type}: count=${r.count}, quality=${r.avg_quality}, fresh=${r.avg_freshness}, bullish=${r.bullish}, bearish=${r.bearish}`);
  }
  if (payload.bySymbol.length > 0) {
    lines.push('');
    lines.push('심볼별 (top 10):');
    for (const r of payload.bySymbol.slice(0, 10)) {
      lines.push(`  ${r.symbol}: count=${r.count}, quality=${r.avg_quality}, dir=[${r.directions || '-'}]`);
    }
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs();
  const payload = await buildReport(args);
  if (args.json) console.log(JSON.stringify(payload, null, 2));
  else console.log(renderText(payload));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: () => db.initSchema(),
    run: main,
    errorPrefix: '❌ runtime-external-evidence-report 오류:',
  });
}

export { buildReport };
