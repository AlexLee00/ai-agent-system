// @ts-nocheck
'use strict';

const path = require('path');
const { WARNING_CODES } = require('../constants.ts');
const {
  buildSection,
  createBaseMetadata,
  decodeXmlEntities,
  finalizeExtraction,
  normalizeText,
  runCommand,
} = require('../utils.ts');

const MAX_SHEETS = 20;
const MAX_ROWS_PER_SHEET = 2000;
const ROW_BLOCK_SIZE = 50;

function listZipEntries(filePath) {
  return runCommand('unzip', ['-Z1', filePath])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function readZipEntry(filePath, entry, encoding = 'utf8') {
  return runCommand('unzip', ['-p', filePath, entry], { encoding });
}

function parseWorkbookXml(xml) {
  const sheets = [];
  const re = /<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/?>/g;
  let match;
  while ((match = re.exec(xml)) !== null) {
    sheets.push({ name: decodeXmlEntities(match[1]), relId: match[2] });
  }
  return sheets;
}

function parseRelationshipsXml(xml) {
  const rels = new Map();
  const re = /<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?>/g;
  let match;
  while ((match = re.exec(xml)) !== null) {
    rels.set(match[1], match[2]);
  }
  return rels;
}

function parseSharedStringsXml(xml) {
  const values = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let match;
  while ((match = re.exec(xml)) !== null) {
    const text = decodeXmlEntities(
      Array.from(match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g))
        .map((textMatch) => textMatch[1])
        .join('')
    );
    values.push(normalizeText(text));
  }
  return values;
}

function parseSheetRows(xml, sharedStrings = []) {
  const rows = [];
  const rowRe = /<row\b[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(xml)) !== null) {
    const rowNumber = Number(rowMatch[1]);
    const cells = [];
    const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowMatch[2])) !== null) {
      const attrs = cellMatch[1];
      const ref = /r="([^"]+)"/.exec(attrs)?.[1] || '';
      const col = ref.replace(/\d+/g, '') || '';
      const type = /t="([^"]+)"/.exec(attrs)?.[1] || '';
      const rawValue = /<v>([\s\S]*?)<\/v>/.exec(cellMatch[2])?.[1] || '';
      const inlineValue = Array.from(cellMatch[2].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g))
        .map((match) => match[1])
        .join('');
      let value = decodeXmlEntities(rawValue || inlineValue);
      if (type === 's') {
        value = sharedStrings[Number(rawValue)] || '';
      }
      value = normalizeText(value);
      if (!value) continue;
      cells.push({ column: col, value });
    }
    rows.push({ rowNumber, cells });
  }
  return rows;
}

function rowsToText(sheetName, rows, warnings) {
  if (!rows.length) {
    warnings.push(`${WARNING_CODES.XLSX_EMPTY_SHEET}:${sheetName}`);
    return { text: `# Sheet: ${sheetName}\n(빈 시트)`, sections: [] };
  }

  const safeRows = rows.slice(0, MAX_ROWS_PER_SHEET);
  if (rows.length > MAX_ROWS_PER_SHEET) {
    warnings.push(`${WARNING_CODES.XLSX_TRUNCATED}:${sheetName}`);
  }

  const lines = [`# Sheet: ${sheetName}`];
  const sections = [];

  for (let index = 0; index < safeRows.length; index += ROW_BLOCK_SIZE) {
    const block = safeRows.slice(index, index + ROW_BLOCK_SIZE);
    const blockLines = block.map((row) => {
      const values = row.cells.map((cell) => `${cell.column}: ${cell.value}`).join(' | ');
      return `Row ${row.rowNumber} | ${values}`;
    });
    lines.push(...blockLines);
    sections.push(buildSection('sheet_row_block', sections.length + 1, sheetName, blockLines.join('\n'), {
      sheetName,
      rowStart: block[0]?.rowNumber || 0,
      rowEnd: block[block.length - 1]?.rowNumber || 0,
    }));
  }

  return {
    text: lines.join('\n'),
    sections,
  };
}

async function extractXlsxDocument({ filePath }) {
  const warnings = [];
  const entries = listZipEntries(filePath);
  if (!entries.length) {
    return finalizeExtraction({
      text: '',
      metadata: createBaseMetadata({
        sourceFileType: 'xlsx',
        extractionMethod: 'xlsx_xml',
        equivalentCount: 0,
        extractionWarnings: [WARNING_CODES.ZIP_LIST_FAILED],
        chunkStrategy: 'sheet_row_block',
      }),
    });
  }

  const workbookXml = readZipEntry(filePath, 'xl/workbook.xml');
  const workbookRelsXml = readZipEntry(filePath, 'xl/_rels/workbook.xml.rels');
  const sharedStringsXml = entries.includes('xl/sharedStrings.xml') ? readZipEntry(filePath, 'xl/sharedStrings.xml') : '';
  if (!sharedStringsXml) warnings.push(WARNING_CODES.XLSX_SHARED_STRINGS_MISSING);

  const sheets = parseWorkbookXml(workbookXml).slice(0, MAX_SHEETS);
  if (parseWorkbookXml(workbookXml).length > MAX_SHEETS) warnings.push(WARNING_CODES.XLSX_TOO_LARGE);
  const relationships = parseRelationshipsXml(workbookRelsXml);
  const sharedStrings = sharedStringsXml ? parseSharedStringsXml(sharedStringsXml) : [];

  const textParts = [];
  const sections = [];

  for (const sheet of sheets) {
    const target = relationships.get(sheet.relId);
    if (!target) {
      warnings.push(`${WARNING_CODES.ZIP_ENTRY_MISSING}:${sheet.name}`);
      continue;
    }
    const normalizedTarget = path.posix.join('xl', target.replace(/^\.\//, ''));
    const sheetXml = readZipEntry(filePath, normalizedTarget);
    const rows = parseSheetRows(sheetXml, sharedStrings);
    const rendered = rowsToText(sheet.name, rows, warnings);
    textParts.push(rendered.text);
    sections.push(...rendered.sections);
  }

  return finalizeExtraction({
    text: textParts.join('\n\n'),
    metadata: createBaseMetadata({
      sourceFileType: 'xlsx',
      extractionMethod: 'xlsx_xml',
      equivalentCount: sheets.length,
      extractionWarnings: warnings,
      chunkStrategy: 'sheet_row_block',
      sections,
      sourceConfidence: 0.92,
    }),
  });
}

module.exports = {
  key: 'xlsx',
  canHandle: ({ sourceFileType }) => sourceFileType === 'xlsx',
  extract: extractXlsxDocument,
  _private: {
    parseRelationshipsXml,
    parseSharedStringsXml,
    parseSheetRows,
    parseWorkbookXml,
    rowsToText,
  },
};
