#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  ensureSystemPreferencesTable,
  getRecentSelectorOverrideSuggestionLogs,
  getSelectorOverrideSuggestionLogById,
  updateSelectorOverrideSuggestionLogReview,
} = require(path.join(__dirname, '../bots/worker/lib/llm-api-monitoring'));

const VALID_STATUSES = new Set(['pending', 'hold', 'approved', 'rejected', 'applied']);

function parseArgs(argv = process.argv.slice(2)) {
  const id = argv.find((arg) => arg.startsWith('--id='))?.split('=')[1] || null;
  const status = argv.find((arg) => arg.startsWith('--status='))?.split('=')[1] || null;
  const note = argv.find((arg) => arg.startsWith('--note='))?.split('=')[1] || null;
  const limit = Math.max(1, Number(argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1] || 10));
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
    `- #${row.id} ${row.label || row.selector_key}`,
    `  selector: ${row.selector_key}`,
    `  decision: ${row.decision}`,
    `  candidate: ${row.candidate_model || '-'}`,
    `  status: ${row.review_status}`,
    `  captured: ${row.captured_at}`,
    `  reviewed_at: ${row.reviewed_at || '-'}`,
    `  applied_at: ${row.applied_at || '-'}`,
    `  note: ${row.review_note || '-'}`,
  ].join('\n');
}

function printList(rows) {
  if (!rows.length) {
    process.stdout.write('저장된 selector override 추천 이력이 없습니다.\n');
    return;
  }
  const lines = ['🗂️ LLM selector override 추천 이력', ''];
  for (const row of rows) {
    lines.push(formatSummaryRow(row));
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function printUpdated(row) {
  const lines = [
    '✅ LLM selector override 추천 검토 상태 갱신',
    '',
    `- id: ${row.id}`,
    `- selector: ${row.selector_key}`,
    `- status: ${row.review_status}`,
    `- reviewed_at: ${row.reviewed_at || '-'}`,
    `- applied_at: ${row.applied_at || '-'}`,
    `- note: ${row.review_note || '-'}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main() {
  const { id, status, note, limit, json, list } = parseArgs();
  await ensureSystemPreferencesTable();

  if (list) {
    const rows = await getRecentSelectorOverrideSuggestionLogs(limit);
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

  const existing = await getSelectorOverrideSuggestionLogById(id);
  if (!existing) {
    throw new Error(`selector override 추천 이력을 찾을 수 없습니다: ${id}`);
  }

  const updated = await updateSelectorOverrideSuggestionLogReview(id, {
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
