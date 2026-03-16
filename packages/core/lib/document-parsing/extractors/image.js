'use strict';

const os = require('os');
const path = require('path');
const { WARNING_CODES } = require('../constants');
const {
  buildSection,
  createBaseMetadata,
  finalizeExtraction,
  runCommand,
} = require('../utils');

const SWIFT_SCRIPT = path.join(__dirname, '../swift/ocr.swift');

function runImageOcr(filePath) {
  const output = runCommand('swift', [SWIFT_SCRIPT, 'image-ocr', filePath], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      HOME: os.tmpdir(),
      SWIFT_MODULE_CACHE_PATH: path.join(os.tmpdir(), 'swift-module-cache'),
      CLANG_MODULE_CACHE_PATH: path.join(os.tmpdir(), 'clang-module-cache'),
    },
  });
  return JSON.parse(output);
}

async function extractImageDocument({ filePath }) {
  let result;
  const warnings = [];
  try {
    result = runImageOcr(filePath);
  } catch (error) {
    warnings.push(WARNING_CODES.OCR_FAILED);
    return finalizeExtraction({
      text: '',
      metadata: createBaseMetadata({
        sourceFileType: 'image',
        extractionMethod: 'image_ocr',
        equivalentCount: 1,
        extractionWarnings: warnings,
        chunkStrategy: 'image_block',
        sourceConfidence: 0,
        extra: {
          imageOcrUsed: true,
          imageCount: 1,
        },
      }),
    });
  }

  warnings.push(...(result.warnings || []));
  const sourceConfidence = typeof result.confidence === 'number' ? Number(result.confidence.toFixed(4)) : null;
  return finalizeExtraction({
    text: result.text || '',
    metadata: createBaseMetadata({
      sourceFileType: 'image',
      extractionMethod: 'image_ocr',
      equivalentCount: 1,
      extractionWarnings: warnings,
      chunkStrategy: 'image_block',
      sourceConfidence,
      sections: [
        buildSection('image_block', 1, 'image_ocr', result.text || '', {
          width: result.width || null,
          height: result.height || null,
        }),
      ],
      extra: {
        imageOcrUsed: true,
        imageCount: 1,
        ocrConfidence: sourceConfidence,
      },
    }),
  });
}

module.exports = {
  key: 'image',
  canHandle: ({ sourceFileType }) => sourceFileType === 'image',
  extract: extractImageDocument,
  _private: {
    runImageOcr,
  },
};
