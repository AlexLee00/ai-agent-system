'use strict';

const path = require('path');
const { extractDocument } = require('../../../packages/core/lib/document-parser');
const pgPool = require('../../../packages/core/lib/pg-pool');
const { parseExpenseRowsFromXlsxExtraction } = require('../lib/expenses-import');
const { buildWorkerCliInsight } = require('../lib/cli-insight.legacy.js');

const SCHEMA = 'worker';

function parseArgs(argv) {
  const options = {
    companyId: 'test-company',
    files: [],
  };

  for (const arg of argv) {
    if (arg.startsWith('--company=')) {
      options.companyId = arg.split('=')[1] || options.companyId;
      continue;
    }
    options.files.push(arg);
  }

  return options;
}

async function loadExistingSignatures(companyId) {
  const rows = await pgPool.query(SCHEMA, `
    SELECT TO_CHAR(date, 'YYYY-MM-DD') AS date,
           COALESCE(category, '') AS category,
           COALESCE(item_name, '') AS item_name,
           amount,
           COALESCE(note, '') AS note
      FROM worker.expenses
     WHERE company_id = $1
       AND source_type = 'excel_import'
       AND deleted_at IS NULL
  `, [companyId]);

  return new Set(
    rows.map((row) => [row.date, row.category, row.item_name, String(row.amount), row.note].join('|'))
  );
}

async function importFile({ filePath, companyId, signatureSet }) {
  const filename = path.basename(filePath);
  const extraction = await extractDocument({
    filePath,
    originalName: filename,
  });

  const rows = parseExpenseRowsFromXlsxExtraction(extraction.text || '');
  if (!rows.length) {
    return {
      filename,
      parsedCount: 0,
      importedCount: 0,
      skippedCount: 0,
      warning: '매입내역 시트에서 반영할 행을 찾지 못했습니다.',
    };
  }

  let importedCount = 0;
  let skippedCount = 0;

  for (const row of rows) {
    const signature = [row.date, row.category || '', row.item_name || '', String(row.amount), row.note || ''].join('|');
    if (signatureSet.has(signature)) {
      skippedCount += 1;
      continue;
    }

    await pgPool.run(SCHEMA, `
      INSERT INTO worker.expenses (
        company_id,
        date,
        category,
        item_name,
        amount,
        quantity,
        unit_price,
        note,
        expense_type,
        source_type,
        source_file_id,
        source_row_key,
        registered_by
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    `, [
      companyId,
      row.date,
      row.category || '기타',
      row.item_name || null,
      row.amount,
      row.quantity,
      row.unit_price,
      row.note || null,
      row.expense_type || 'variable',
      'excel_import',
      null,
      `${filename}:${row.source_row_key || ''}`,
      null,
    ]);

    signatureSet.add(signature);
    importedCount += 1;
  }

  return {
    filename,
    parsedCount: rows.length,
    importedCount,
    skippedCount,
    warning: null,
  };
}

async function main() {
  const { companyId, files } = parseArgs(process.argv.slice(2));
  if (!files.length) {
    console.error('사용법: node bots/worker/scripts/import-expenses-from-excel.js [--company=test-company] <xlsx...>');
    process.exit(1);
  }

  const signatureSet = await loadExistingSignatures(companyId);
  const results = [];
  for (const filePath of files) {
    results.push(await importFile({ filePath, companyId, signatureSet }));
  }

  const summary = await pgPool.get(SCHEMA, `
    SELECT COUNT(*)::int AS count,
           COALESCE(SUM(amount), 0)::bigint AS total
      FROM worker.expenses
     WHERE company_id = $1
       AND deleted_at IS NULL
  `, [companyId]);

  const aiSummary = await buildWorkerCliInsight({
    bot: 'import-expenses-from-excel',
    requestType: 'expense-import',
    title: '워커 엑셀 비용 반영 결과',
    data: {
      companyId,
      fileCount: results.length,
      importedCount: results.reduce((sum, item) => sum + Number(item.importedCount || 0), 0),
      skippedCount: results.reduce((sum, item) => sum + Number(item.skippedCount || 0), 0),
      totalExpensesCount: Number(summary?.count || 0),
      totalExpensesAmount: Number(summary?.total || 0),
    },
    fallback: results.some((item) => Number(item.importedCount || 0) > 0)
      ? '엑셀 비용 데이터가 반영돼 지출 원장이 최신 상태에 더 가까워졌습니다.'
      : '새로 반영된 비용은 없고 중복 건만 건너뛰었을 가능성이 높습니다.',
  });

  console.log(JSON.stringify({
    ok: true,
    companyId,
    files: results,
    totals: {
      expensesCount: Number(summary?.count || 0),
      expensesAmount: Number(summary?.total || 0),
    },
    aiSummary,
  }, null, 2));
}

main().catch((error) => {
  console.error('[import-expenses-from-excel] 실패:', error?.stack || error?.message || error);
  process.exit(1);
});
