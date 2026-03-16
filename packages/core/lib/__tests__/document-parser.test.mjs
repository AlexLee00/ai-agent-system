import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { extractDocument, createExtractorRegistry } = require('../document-parser');
const xlsxExtractor = require('../document-parsing/extractors/xlsx');
const pptxExtractor = require('../document-parsing/extractors/pptx');

test('registry resolves known file types', () => {
  const registry = createExtractorRegistry();
  assert.equal(registry.resolve({ sourceFileType: 'pdf' }).key, 'pdf');
  assert.equal(registry.resolve({ sourceFileType: 'txt' }).key, 'txt');
  assert.equal(registry.resolve({ sourceFileType: 'xlsx' }).key, 'xlsx');
  assert.equal(registry.resolve({ sourceFileType: 'pptx' }).key, 'pptx');
  assert.equal(registry.resolve({ sourceFileType: 'image' }).key, 'image');
});

test('txt extractor returns normalized text and metadata contract', async () => {
  const filePath = path.join(os.tmpdir(), `doc-parser-${Date.now()}.txt`);
  fs.writeFileSync(filePath, ' 첫 줄  \r\n\r\n둘째 줄\t\t', 'utf8');
  const result = await extractDocument({ filePath, originalName: 'sample.txt', mimeType: 'text/plain' });
  assert.equal(result.metadata.sourceFileType, 'txt');
  assert.equal(result.metadata.extractionMethod, 'plain_text');
  assert.equal(result.text, '첫 줄\n\n둘째 줄');
  assert.ok(Array.isArray(result.metadata.extractionWarnings));
});

test('xlsx xml parsing keeps sheet and row structure', () => {
  const workbook = xlsxExtractor._private.parseWorkbookXml('<sheet name="매출" r:id="rId1"/>');
  assert.equal(workbook[0].name, '매출');

  const shared = xlsxExtractor._private.parseSharedStringsXml('<si><t>이름</t></si><si><t>값</t></si>');
  assert.deepEqual(shared, ['이름', '값']);

  const rows = xlsxExtractor._private.parseSheetRows(
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>12</v></c></row>',
    shared
  );
  assert.equal(rows[0].cells[0].value, '이름');
  assert.equal(rows[0].cells[1].value, '12');
});

test('pptx xml parsing keeps slide order and title/body split', () => {
  const slideIds = pptxExtractor._private.parsePresentationXml('<p:sldId r:id="rId3"/><p:sldId r:id="rId4"/>');
  assert.deepEqual(slideIds, ['rId3', 'rId4']);

  const rendered = pptxExtractor._private.renderSlide(
    1,
    '<a:t>제목</a:t><a:t>첫 줄</a:t><a:t>둘째 줄</a:t>',
    '<a:t>노트</a:t>'
  );
  assert.match(rendered.text, /Slide 1: 제목/);
  assert.match(rendered.text, /첫 줄/);
  assert.match(rendered.text, /Notes:/);
});
