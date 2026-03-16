import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { extractDocument, createExtractorRegistry } = require('../document-parser');
const xlsxExtractor = require('../document-parsing/extractors/xlsx');
const docxExtractor = require('../document-parsing/extractors/docx');
const docExtractor = require('../document-parsing/extractors/doc');
const pptxExtractor = require('../document-parsing/extractors/pptx');
const imageExtractor = require('../document-parsing/extractors/image');

test('registry resolves known file types', () => {
  const registry = createExtractorRegistry();
  assert.equal(registry.resolve({ sourceFileType: 'pdf' }).key, 'pdf');
  assert.equal(registry.resolve({ sourceFileType: 'txt' }).key, 'txt');
  assert.equal(registry.resolve({ sourceFileType: 'xlsx' }).key, 'xlsx');
  assert.equal(registry.resolve({ sourceFileType: 'docx' }).key, 'docx');
  assert.equal(registry.resolve({ sourceFileType: 'doc' }).key, 'doc');
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

test('docx xml parsing keeps heading and list structure', () => {
  const paragraphs = docxExtractor._private.parseParagraphs(
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>제목</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>본문 첫 줄</w:t></w:r></w:p>'
    + '<w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>목록 항목</w:t></w:r></w:p>'
  );
  assert.equal(paragraphs[0].text, '# 제목');
  assert.equal(paragraphs[1].text, '본문 첫 줄');
  assert.equal(paragraphs[2].text, '- 목록 항목');

  const rendered = docxExtractor._private.renderDocx(paragraphs, []);
  assert.match(rendered.text, /# 제목/);
  assert.match(rendered.text, /- 목록 항목/);
  assert.equal(rendered.sections[0].type, 'docx_paragraph_block');
});

test('doc extractor resolves system converter priority', () => {
  const originalPath = process.env.PATH;
  process.env.PATH = '';
  try {
    assert.equal(docExtractor._private.resolveDocConverter(), null);
  } finally {
    process.env.PATH = originalPath;
  }
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

test('image quality heuristics produce conservative signals for sparse low-quality OCR', () => {
  const quality = imageExtractor._private.evaluateImageOcrQuality({
    text: '확인',
    width: 320,
    height: 1200,
    confidence: 0.41,
    warnings: [],
  });

  assert.equal(quality.imageEstimatedLowQuality, true);
  assert.equal(quality.imageEstimatedSparseText, true);
  assert.equal(quality.imageQualitySeverity, 'high');
  assert.equal(quality.imageRoutingBias, 'conservative_json');
  assert.equal(quality.imageAdaptiveStrategyBias, 'conservative');
  assert.equal(quality.imageConservativeHandling, true);
  assert.ok(quality.imageOcrWarnings.includes('image_text_sparse'));
  assert.ok(quality.imageOcrWarnings.includes('image_quality_low'));
  assert.ok(quality.imageOcrWarnings.includes('image_rotation_detected'));
  assert.ok(quality.imageOcrWarnings.includes('image_ocr_low_confidence'));
});

test('image quality heuristics stay permissive for large readable OCR', () => {
  const quality = imageExtractor._private.evaluateImageOcrQuality({
    text: [
      '영수증 합계 12900',
      '카드 승인 완료',
      '매장명 테스트 상점',
      '결제 시각 2026-03-17 09:12',
      '사업자번호 123-45-67890',
      '전화 02-1234-5678',
      '주소 서울시 강남구 테스트로 1',
      '상품A 5900',
      '상품B 7000',
    ].join('\n'),
    width: 1600,
    height: 1200,
    confidence: 0.93,
    warnings: [],
  });

  assert.equal(quality.imageEstimatedLowQuality, false);
  assert.equal(quality.imageQualitySeverity, 'none');
  assert.equal(quality.imageRoutingBias, 'default');
  assert.equal(quality.imageConservativeHandling, false);
});
