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

const MAX_SLIDES = 100;

function listZipEntries(filePath) {
  return runCommand('unzip', ['-Z1', filePath])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function readZipEntry(filePath, entry, encoding = 'utf8') {
  return runCommand('unzip', ['-p', filePath, entry], { encoding });
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

function parsePresentationXml(xml) {
  const slideRelIds = [];
  const re = /<p:sldId\b[^>]*r:id="([^"]+)"/g;
  let match;
  while ((match = re.exec(xml)) !== null) {
    slideRelIds.push(match[1]);
  }
  return slideRelIds;
}

function extractTextRuns(xml) {
  return Array.from(xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g))
    .map((match) => normalizeText(decodeXmlEntities(match[1])))
    .filter(Boolean);
}

function renderSlide(slideNumber, slideXml, notesXml = '') {
  const lines = extractTextRuns(slideXml);
  const notes = extractTextRuns(notesXml);
  const title = lines[0] || `슬라이드 ${slideNumber}`;
  const body = lines.slice(1).join('\n');
  const noteText = notes.join('\n');
  const parts = [`# Slide ${slideNumber}: ${title}`];
  if (body) parts.push(body);
  if (noteText) parts.push(`Notes:\n${noteText}`);
  return {
    text: parts.join('\n'),
    section: buildSection('slide', slideNumber, title, parts.join('\n'), {
      slideNumber,
      noteLength: noteText.length,
    }),
  };
}

async function extractPptxDocument({ filePath }) {
  const warnings = [];
  const entries = listZipEntries(filePath);
  const presentationXml = readZipEntry(filePath, 'ppt/presentation.xml');
  const presentationRelsXml = readZipEntry(filePath, 'ppt/_rels/presentation.xml.rels');
  const rels = parseRelationshipsXml(presentationRelsXml);
  const slideRelIds = parsePresentationXml(presentationXml).slice(0, MAX_SLIDES);
  if (parsePresentationXml(presentationXml).length > MAX_SLIDES) warnings.push(WARNING_CODES.PPTX_TRUNCATED);

  const sections = [];
  const textParts = [];

  slideRelIds.forEach((relId, index) => {
    const target = rels.get(relId);
    if (!target) {
      warnings.push(`${WARNING_CODES.ZIP_ENTRY_MISSING}:slide-${index + 1}`);
      return;
    }
    const slidePath = path.posix.join('ppt', target.replace(/^\.\//, ''));
    const slideXml = readZipEntry(filePath, slidePath);
    const slideNumber = index + 1;
    const notesPath = `ppt/notesSlides/notesSlide${slideNumber}.xml`;
    const notesXml = entries.includes(notesPath) ? readZipEntry(filePath, notesPath) : '';
    if (!notesXml) warnings.push(`${WARNING_CODES.PPTX_NOTES_MISSING}:${slideNumber}`);
    const rendered = renderSlide(slideNumber, slideXml, notesXml);
    if (!rendered.text.trim()) {
      warnings.push(`${WARNING_CODES.PPTX_EMPTY_SLIDE}:${slideNumber}`);
    }
    textParts.push(rendered.text);
    sections.push(rendered.section);
  });

  return finalizeExtraction({
    text: textParts.join('\n\n'),
    metadata: createBaseMetadata({
      sourceFileType: 'pptx',
      extractionMethod: 'pptx_xml',
      equivalentCount: slideRelIds.length,
      extractionWarnings: warnings,
      chunkStrategy: 'slide',
      sections,
      sourceConfidence: 0.9,
    }),
  });
}

module.exports = {
  key: 'pptx',
  canHandle: ({ sourceFileType }) => sourceFileType === 'pptx',
  extract: extractPptxDocument,
  _private: {
    extractTextRuns,
    parsePresentationXml,
    parseRelationshipsXml,
    renderSlide,
  },
};
