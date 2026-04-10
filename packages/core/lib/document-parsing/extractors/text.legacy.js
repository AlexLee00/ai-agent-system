'use strict';

const { WARNING_CODES } = require('../constants');
const {
  createBaseMetadata,
  decodeTextBuffer,
  finalizeExtraction,
  safeReadFileBuffer,
} = require('../utils');

async function extractTextDocument({ filePath }) {
  const warnings = [];
  const { text, warning } = decodeTextBuffer(safeReadFileBuffer(filePath));
  if (warning) warnings.push(WARNING_CODES.TEXT_ENCODING_FALLBACK);
  if (!String(text || '').trim()) warnings.push(WARNING_CODES.TEXT_EMPTY);

  return finalizeExtraction({
    text,
    metadata: createBaseMetadata({
      sourceFileType: 'txt',
      extractionMethod: 'plain_text',
      equivalentCount: 1,
      extractionWarnings: warnings,
      chunkStrategy: 'document',
      sections: [],
      sourceConfidence: 1,
    }),
  });
}

module.exports = {
  key: 'txt',
  canHandle: ({ sourceFileType }) => sourceFileType === 'txt',
  extract: extractTextDocument,
};
