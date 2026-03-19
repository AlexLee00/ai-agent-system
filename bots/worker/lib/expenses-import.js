'use strict';

const kst = require('../../../packages/core/lib/kst');

function excelSerialToDate(serialValue) {
  const numeric = Number(serialValue);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const utcMillis = Date.UTC(1899, 11, 30) + Math.round(numeric) * 24 * 60 * 60 * 1000;
  return new Date(utcMillis).toISOString().slice(0, 10);
}

function inferExpenseType(category = '', itemName = '') {
  const text = `${category} ${itemName}`;
  return /(월세|관리비|세무기장|인터넷\/전화|렌탈|CCTV|키오스크|정수기|공기청정기|프린터)/.test(text)
    ? 'fixed'
    : 'variable';
}

function parseLineCells(line = '') {
  return String(line)
    .split('|')
    .slice(1)
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, token) => {
      const match = token.match(/^([A-Z]+):\s*(.*)$/);
      if (!match) return acc;
      acc[match[1]] = match[2] || '';
      return acc;
    }, {});
}

function parseExpenseRowsFromXlsxExtraction(text = '') {
  const lines = String(text || '').split('\n');
  const rows = [];
  let inExpenseSheet = false;
  let headerMap = null;

  for (const line of lines) {
    if (line.startsWith('# Sheet: ')) {
      inExpenseSheet = line.trim() === '# Sheet: 매입내역';
      headerMap = null;
      continue;
    }
    if (!inExpenseSheet) continue;
    if (!line.startsWith('Row ')) continue;

    const rowNumberMatch = line.match(/^Row\s+(\d+)/);
    const rowNumber = Number(rowNumberMatch?.[1] || 0);
    const cells = parseLineCells(line);
    if (!headerMap) {
      headerMap = cells;
      continue;
    }

    const date = excelSerialToDate(cells.B || cells.A);
    const category = String(cells.D || '').trim() || '기타';
    const itemName = String(cells.E || '').trim();
    const amount = Number(String(cells.F || '0').replace(/[^\d.-]/g, ''));
    const quantity = Number(String(cells.G || '0').replace(/[^\d.-]/g, ''));
    const unitPrice = Number(String(cells.H || '0').replace(/[^\d.-]/g, ''));
    const note = String(cells.I || '').trim();
    if (!date || !Number.isFinite(amount) || amount <= 0) continue;

    rows.push({
      rowNumber,
      date,
      category,
      item_name: itemName || null,
      amount,
      quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : null,
      unit_price: Number.isFinite(unitPrice) && unitPrice > 0 ? unitPrice : null,
      note: note || null,
      expense_type: inferExpenseType(category, itemName),
      source_row_key: `expense-sheet:매입내역:row:${rowNumber}:${date}:${category}:${itemName || ''}:${amount}`,
      source_type: 'excel_import',
      month_hint: String(cells.C || '').trim() || null,
    });
  }

  return rows;
}

function buildExpenseImportNotice({ filename, importedCount, skippedCount }) {
  return `${filename} 파일에서 매입 ${importedCount}건을 반영했고, 중복 ${skippedCount}건은 건너뛰었습니다.`;
}

module.exports = {
  buildExpenseImportNotice,
  excelSerialToDate,
  inferExpenseType,
  parseExpenseRowsFromXlsxExtraction,
};
