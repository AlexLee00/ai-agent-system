#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const pgPool = require('../../../packages/core/lib/pg-pool');
const { buildReservationCliInsight } = require('../lib/cli-insight');

function getArg(name) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find(arg => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function csvCell(value) {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function buildExportFallback(payload) {
  return `스카 매출 CSV는 최근 ${payload.days}일 기준 ${payload.rows}행으로 내보내졌고, 공유용 원본은 ${path.basename(payload.output)}입니다.`;
}

async function main() {
  const days = Number.parseInt(getArg('days') || '100', 10);
  const outputPath = getArg('output') || path.join(os.homedir(), 'Downloads', 'ska-sales-last-100-days.csv');

  const rows = await pgPool.query('reservation', `
    SELECT
      date,
      total_amount,
      pickko_study_room,
      general_revenue,
      COALESCE(general_revenue, 0) + COALESCE(pickko_study_room, 0) AS combined_revenue,
      entries_count
    FROM daily_summary
    WHERE date::date >= CURRENT_DATE - ($1::int - 1)
    ORDER BY date::date DESC
  `, [days]);

  const header = [
    'date',
    'booking_total_amount',
    'study_room_total_amount',
    'recognized_total_revenue',
    'study_room_revenue',
    'study_cafe_revenue',
    'combined_revenue',
    'entries_count',
  ];

  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push([
      row.date,
      row.total_amount ?? 0,
      row.pickko_study_room ?? 0,
      row.combined_revenue ?? 0,
      row.pickko_study_room ?? 0,
      row.general_revenue ?? 0,
      row.combined_revenue ?? 0,
      row.entries_count ?? 0,
    ].map(csvCell).join(','));
  }

  fs.writeFileSync(outputPath, lines.join('\n') + '\n', 'utf8');
  const payload = {
    ok: true,
    output: outputPath,
    rows: rows.length,
    days,
  };
  payload.aiSummary = await buildReservationCliInsight({
    bot: 'export-ska-sales-csv',
    requestType: 'export-ska-sales-csv',
    title: '스카 매출 CSV 내보내기 요약',
    data: {
      output: outputPath,
      rows: rows.length,
      days,
      topDates: rows.slice(0, 5).map((row) => row.date),
    },
    fallback: buildExportFallback(payload),
  });
  console.log(JSON.stringify(payload));
}

main().catch(err => {
  console.error(JSON.stringify({
    ok: false,
    error: err.message,
  }));
  process.exit(1);
});
