// @ts-nocheck
'use strict';

const { WARNING_CODES } = require('../constants.ts');
const {
  createBaseMetadata,
  finalizeExtraction,
  normalizeText,
  runCommand,
} = require('../utils.ts');

function resolveDocConverter() {
  try {
    runCommand('textutil', ['-help']);
    return {
      command: 'textutil',
      args: (filePath) => ['-convert', 'txt', '-stdout', filePath],
      extractionMethod: 'word_legacy_doc_textutil',
      sourceConfidence: 0.82,
    };
  } catch {}

  try {
    runCommand('antiword', ['-h']);
    return {
      command: 'antiword',
      args: (filePath) => [filePath],
      extractionMethod: 'word_legacy_doc_antiword',
      sourceConfidence: 0.78,
    };
  } catch {}

  return null;
}

async function extractLegacyDoc({ filePath }) {
  const warnings = [];
  const converter = resolveDocConverter();
  if (!converter) {
    return finalizeExtraction({
      text: '',
      metadata: createBaseMetadata({
        sourceFileType: 'doc',
        extractionMethod: 'word_legacy_doc_unavailable',
        equivalentCount: 0,
        extractionWarnings: [WARNING_CODES.DOC_PARSER_UNAVAILABLE],
        chunkStrategy: 'document',
        sourceConfidence: 0,
      }),
    });
  }

  const raw = runCommand(converter.command, converter.args(filePath));
  const text = normalizeText(raw);
  if (!text) warnings.push(WARNING_CODES.DOC_TEXT_NOT_FOUND);

  return finalizeExtraction({
    text,
    metadata: createBaseMetadata({
      sourceFileType: 'doc',
      extractionMethod: converter.extractionMethod,
      equivalentCount: 1,
      extractionWarnings: warnings,
      chunkStrategy: 'document',
      sourceConfidence: converter.sourceConfidence,
    }),
  });
}

module.exports = {
  key: 'doc',
  canHandle: ({ sourceFileType }) => sourceFileType === 'doc',
  extract: extractLegacyDoc,
  _private: {
    resolveDocConverter,
  },
};
