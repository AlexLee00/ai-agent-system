import path from 'node:path';

const { WARNING_CODES } = require('./document-parsing/constants.ts');
const { createExtractorRegistry } = require('./document-parsing/registry.ts');
const {
  createBaseMetadata,
  detectFileType,
  finalizeExtraction,
} = require('./document-parsing/utils.ts');

type ExtractInput = {
  filePath?: string;
  [key: string]: unknown;
};

type ExtractResult = {
  text: string;
  metadata: Record<string, unknown>;
};

const registry = createExtractorRegistry();

async function extractDocument(input: ExtractInput = {}): Promise<ExtractResult> {
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
    const err = error as { message?: string };
    return finalizeExtraction({
      text: '',
      metadata: createBaseMetadata({
        sourceFileType,
        extractionMethod: `${extractor.key}_failed`,
        equivalentCount: 0,
        extractionWarnings: [`${WARNING_CODES.EXTRACTOR_FAILED}:${extractor.key}`],
        chunkStrategy: 'document',
        chunkWarnings: [String(err?.message || error)],
        sourceConfidence: 0,
      }),
    });
  }
}

export = {
  extractDocument,
  createExtractorRegistry,
  WARNING_CODES,
};
