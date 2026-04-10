#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/review-runtime-config-suggestion.js
 *
 * 저장된 runtime_config 제안 스냅샷의 검토 상태를 갱신하거나 최근 제안 목록을 출력한다.
 */

import * as db from '../shared/db.ts';

const VALID_STATUSES = new Set(['pending', 'hold', 'approved', 'rejected', 'applied']);

function parseArgs(argv = process.argv.slice(2)) {
  const id = argv.find(arg => arg.startsWith('--id='))?.split('=')[1] || null;
  const status = argv.find(arg => arg.startsWith('--status='))?.split('=')[1] || null;
  const note = argv.find(arg => arg.startsWith('--note='))?.split('=')[1] || null;
  const limit = Math.max(1, Number(argv.find(arg => arg.startsWith('--limit='))?.split('=')[1] || 10));
  return {
    id,
    status,
    note,
    limit,
    json: argv.includes('--json'),
    list: argv.includes('--list') || (!id && !status),
  };
}

function formatSummaryRow(row) {
  return [
    `- ${row.id}`,
    `  captured: ${row.captured_at}`,
    `  status: ${row.review_status}`,
    `  actionable: ${row.actionable_count}`,
    `  reviewed_at: ${row.reviewed_at || '-'}`,
    `  applied_at: ${row.applied_at || '-'}`,
    `  note: ${row.review_note || '-'}`,
  ].join('\n');
}

function printList(rows) {
  if (!rows.length) {
    process.stdout.write('저장된 runtime_config 제안 이력이 없습니다.\n');
    return;
  }
  const lines = ['🗂️ 투자 runtime_config 제안 이력', ''];
  for (const row of rows) {
    lines.push(formatSummaryRow(row));
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function printUpdated(row) {
  const lines = [
    '✅ 투자 runtime_config 제안 검토 상태 갱신',
    '',
    `- id: ${row.id}`,
    `- status: ${row.review_status}`,
    `- reviewed_at: ${row.reviewed_at || '-'}`,
    `- applied_at: ${row.applied_at || '-'}`,
    `- note: ${row.review_note || '-'}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main() {
  const { id, status, note, limit, json, list } = parseArgs();
  await db.initSchema();

  if (list) {
    const rows = await db.getRecentRuntimeConfigSuggestionLogs(limit);
    if (json) {
      process.stdout.write(`${JSON.stringify({ items: rows }, null, 2)}\n`);
      return;
    }
    printList(rows);
    return;
  }

  const normalizedStatus = String(status || '').trim().toLowerCase();
  if (!id || !VALID_STATUSES.has(normalizedStatus)) {
    throw new Error('`--id`와 유효한 `--status=pending|hold|approved|rejected|applied`가 필요합니다.');
  }

  const existing = await db.getRuntimeConfigSuggestionLogById(id);
  if (!existing) {
    throw new Error(`제안 이력을 찾을 수 없습니다: ${id}`);
  }

  const updated = await db.updateRuntimeConfigSuggestionLogReview(id, {
    reviewStatus: normalizedStatus,
    reviewNote: note,
  });

  if (json) {
    process.stdout.write(`${JSON.stringify(updated, null, 2)}\n`);
    return;
  }
  printUpdated(updated);
}

main().catch((error) => {
  process.stderr.write(`❌ ${error?.stack || error?.message || String(error)}\n`);
  process.exit(1);
});
