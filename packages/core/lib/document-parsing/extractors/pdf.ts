// @ts-nocheck
'use strict';

const os = require('os');
const path = require('path');
const { WARNING_CODES } = require('../constants.ts');
const {
  buildSection,
  createBaseMetadata,
  finalizeExtraction,
  normalizeText,
  runCommand,
} = require('../utils.ts');

const SWIFT_SCRIPT = path.join(__dirname, '../swift/ocr.swift');
const PDF_NATIVE_MIN_TEXT = 48;

function runSwiftPdfMode(mode, filePath) {
  const output = runCommand('swift', [SWIFT_SCRIPT, mode, filePath], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      HOME: os.tmpdir(),
      SWIFT_MODULE_CACHE_PATH: path.join(os.tmpdir(), 'swift-module-cache'),
      CLANG_MODULE_CACHE_PATH: path.join(os.tmpdir(), 'clang-module-cache'),
    },
  });
  return JSON.parse(output);
}

function renderPdfPages(pages, prefix = 'Page') {
  const text = [];
  const sections = [];
  for (const page of pages) {
    const title = `${prefix} ${page.index}`;
    const pageText = normalizeText(page.text || '');
    text.push(`# ${title}\n${pageText || '(빈 페이지)'}`);
    sections.push(buildSection('page', page.index, title, pageText, {
      pageNumber: page.index,
      ocrConfidence: page.confidence ?? null,
    }));
  }
  return { text: text.join('\n\n'), sections };
}

async function extractPdfDocument({ filePath }) {
  const warnings = [];
  let nativeResult;
  try {
    nativeResult = runSwiftPdfMode('pdf-native', filePath);
  } catch (error) {
    warnings.push(WARNING_CODES.NATIVE_PDF_TEXT_EMPTY);
    nativeResult = { pageCount: 0, pages: [] };
  }

  const nativeText = normalizeText(nativeResult.pages.map((page) => page.text || '').join('\n\n'));
  const nativeTooShort = nativeText.length < PDF_NATIVE_MIN_TEXT;
  const nativeEmpty = !nativeText.length;
  if (nativeEmpty) warnings.push(WARNING_CODES.NATIVE_PDF_TEXT_EMPTY);
  if (!nativeEmpty && nativeTooShort) warnings.push(WARNING_CODES.NATIVE_PDF_TEXT_TOO_SHORT);

  let extractionMethod = 'native_pdf_text';
  let finalResult = nativeResult;
  let ocrFallbackUsed = false;
  let sections = renderPdfPages(nativeResult.pages).sections;
  let text = renderPdfPages(nativeResult.pages).text;
  let sourceConfidence = nativeText.length ? 0.96 : 0.4;

  if (nativeEmpty || nativeTooShort) {
    try {
      const ocrResult = runSwiftPdfMode('pdf-ocr', filePath);
      extractionMethod = 'pdf_ocr_fallback';
      ocrFallbackUsed = true;
      finalResult = ocrResult;
      warnings.push(WARNING_CODES.OCR_BASED_SOURCE);
      const rendered = renderPdfPages(ocrResult.pages);
      sections = rendered.sections;
      text = rendered.text;
      const confidences = ocrResult.pages
        .map((page) => page.confidence)
        .filter((value) => typeof value === 'number');
      sourceConfidence = confidences.length
        ? Number((confidences.reduce((sum, value) => sum + value, 0) / confidences.length).toFixed(4))
        : 0.6;
    } catch (error) {
      warnings.push(WARNING_CODES.OCR_FAILED);
    }
  }

  return finalizeExtraction({
    text,
    metadata: createBaseMetadata({
      sourceFileType: 'pdf',
      extractionMethod,
      equivalentCount: finalResult.pageCount || nativeResult.pageCount || 0,
      extractionWarnings: Array.from(new Set(warnings)),
      chunkStrategy: 'page',
      sections,
      sourceConfidence,
      extra: {
        nativePdfTextUsed: !ocrFallbackUsed,
        ocrFallbackUsed,
        pageCount: finalResult.pageCount || nativeResult.pageCount || 0,
      },
    }),
  });
}

module.exports = {
  key: 'pdf',
  canHandle: ({ sourceFileType }) => sourceFileType === 'pdf',
  extract: extractPdfDocument,
  _private: {
    runSwiftPdfMode,
  },
};
