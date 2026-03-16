'use strict';

const path = require('path');
const { WARNING_CODES } = require('./document-parsing/constants');
const { createExtractorRegistry } = require('./document-parsing/registry');
const {
  createBaseMetadata,
  detectFileType,
  finalizeExtraction,
} = require('./document-parsing/utils');

const registry = createExtractorRegistry();

async function extractDocument(input = {}) {
  const sourceFileType = detectFileType(input);
  const context = {
    ...input,
    filePath: path.resolve(String(input.filePath || '')),
    sourceFileType,
  };
  const extractor = registry.resolve(context);
  if (!extractor) {
    return finalizeExtraction({
      text: '',
      metadata: createBaseMetadata({
        sourceFileType,
        extractionMethod: 'unsupported',
        equivalentCount: 0,
        extractionWarnings: [WARNING_CODES.UNSUPPORTED_FILE_TYPE],
        chunkStrategy: 'document',
        sourceConfidence: 0,
      }),
    });
  }

  try {
    const result = await extractor.extract(context);
    return {
      text: result.text,
      metadata: {
        ...result.metadata,
        sourceFileType,
      },
    };
  } catch (error) {
    return finalizeExtraction({
      text: '',
      metadata: createBaseMetadata({
        sourceFileType,
        extractionMethod: `${extractor.key}_failed`,
        equivalentCount: 0,
        extractionWarnings: [`${WARNING_CODES.EXTRACTOR_FAILED}:${extractor.key}`],
        chunkStrategy: 'document',
        chunkWarnings: [String(error.message || error)],
        sourceConfidence: 0,
      }),
    });
  }
}

module.exports = {
  extractDocument,
  createExtractorRegistry,
  WARNING_CODES,
};
