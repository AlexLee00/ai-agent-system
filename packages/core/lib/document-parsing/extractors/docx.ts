// @ts-nocheck
'use strict';

const { WARNING_CODES } = require('../constants.ts');
const {
  buildSection,
  createBaseMetadata,
  decodeXmlEntities,
  finalizeExtraction,
  normalizeText,
  runCommand,
} = require('../utils.ts');

const MAX_PARAGRAPHS = 1200;
const PARAGRAPH_BLOCK_SIZE = 40;

function listZipEntries(filePath) {
  return runCommand('unzip', ['-Z1', filePath])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function readZipEntry(filePath, entry, encoding = 'utf8') {
  return runCommand('unzip', ['-p', filePath, entry], { encoding });
}

function parseParagraphs(xml) {
  const paragraphs = [];
  const paragraphRe = /<w:p\b[\s\S]*?<\/w:p>/g;
  let match;
  while ((match = paragraphRe.exec(xml)) !== null) {
    const paragraphXml = match[0];
    const style = /<w:pStyle\b[^>]*w:val="([^"]+)"/.exec(paragraphXml)?.[1] || '';
    const isList = /<w:numPr\b/.test(paragraphXml);
    const runs = [];

    const runRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\b[^>]*\/>/g;
    let runMatch;
    while ((runMatch = runRe.exec(paragraphXml)) !== null) {
      if (runMatch[1] != null) {
        runs.push(decodeXmlEntities(runMatch[1]));
      } else if (runMatch[0].startsWith('<w:tab')) {
        runs.push(' ');
      } else {
        runs.push('\n');
      }
    }

    let text = normalizeText(runs.join(''));
    if (!text) continue;
    if (/^Heading/i.test(style)) {
      text = `# ${text}`;
    } else if (isList) {
      text = `- ${text}`;
    }

    paragraphs.push({
      style,
      isList,
      text,
    });
  }

  return paragraphs;
}

function renderDocx(paragraphs, warnings) {
  if (!paragraphs.length) {
    warnings.push(WARNING_CODES.DOCX_EMPTY_DOCUMENT);
    return {
      text: '',
      sections: [],
    };
  }

  const safeParagraphs = paragraphs.slice(0, MAX_PARAGRAPHS);
  if (paragraphs.length > MAX_PARAGRAPHS) {
    warnings.push(WARNING_CODES.DOCX_TRUNCATED);
  }

  const sections = [];
  const blocks = [];

  for (let index = 0; index < safeParagraphs.length; index += PARAGRAPH_BLOCK_SIZE) {
    const block = safeParagraphs.slice(index, index + PARAGRAPH_BLOCK_SIZE);
    const blockText = block.map((item) => item.text).join('\n');
    const title = block.find((item) => item.style)?.text?.replace(/^#\s*/, '') || `문단 블록 ${sections.length + 1}`;
    sections.push(buildSection('docx_paragraph_block', sections.length + 1, title, blockText, {
      paragraphStart: index + 1,
      paragraphEnd: index + block.length,
    }));
    blocks.push(blockText);
  }

  return {
    text: blocks.join('\n\n'),
    sections,
  };
}

async function extractDocxDocument({ filePath }) {
  const warnings = [];
  const entries = listZipEntries(filePath);
  const documentXml = readZipEntry(filePath, 'word/document.xml');
  const paragraphs = parseParagraphs(documentXml);

  const hasHeaderOrFooter = entries.some((entry) => entry.startsWith('word/header') || entry.startsWith('word/footer'));
  if (!hasHeaderOrFooter) warnings.push(WARNING_CODES.DOCX_HEADER_FOOTER_MISSING);

  const rendered = renderDocx(paragraphs, warnings);
  return finalizeExtraction({
    text: rendered.text,
    metadata: createBaseMetadata({
      sourceFileType: 'docx',
      extractionMethod: 'docx_xml',
      equivalentCount: paragraphs.length,
      extractionWarnings: warnings,
      chunkStrategy: 'docx_paragraph_block',
      sections: rendered.sections,
      sourceConfidence: 0.92,
    }),
  });
}

module.exports = {
  key: 'docx',
  canHandle: ({ sourceFileType }) => sourceFileType === 'docx',
  extract: extractDocxDocument,
  _private: {
    parseParagraphs,
    renderDocx,
  },
};
