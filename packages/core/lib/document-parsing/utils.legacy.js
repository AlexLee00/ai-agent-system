'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { EXTENSION_MAP } = require('./constants');

function normalizeText(text = '') {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[ \u00A0]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeXmlEntities(text = '') {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#xA;/gi, '\n')
    .replace(/&#10;/g, '\n')
    .replace(/&#xD;/gi, '\n')
    .replace(/&#13;/g, '\n');
}

function detectFileType({ filePath = '', originalName = '', mimeType = '' } = {}) {
  const candidate = String(originalName || filePath || '').toLowerCase();
  const ext = path.extname(candidate);
  const normalizedMime = String(mimeType || '').toLowerCase();

  for (const [type, exts] of Object.entries(EXTENSION_MAP)) {
    if (exts.includes(ext)) return type;
  }
  if (/^image\//.test(normalizedMime)) return 'image';
  if (normalizedMime.includes('pdf')) return 'pdf';
  if (normalizedMime.includes('wordprocessingml')) return 'docx';
  if (normalizedMime.includes('msword')) return 'doc';
  if (normalizedMime.includes('presentation')) return 'pptx';
  if (normalizedMime.includes('sheet') || normalizedMime.includes('excel')) return 'xlsx';
  if (normalizedMime.startsWith('text/')) return 'txt';
  return 'unknown';
}

function createBaseMetadata({
  sourceFileType,
  extractionMethod,
  equivalentCount = 1,
  extractionWarnings = [],
  chunkStrategy = 'document',
  chunkWarnings = [],
  sourceConfidence = null,
  sections = [],
  extra = {},
} = {}) {
  return {
    extractionMethod,
    pageCount: equivalentCount,
    extractedTextLength: 0,
    extractionWarnings,
    sourceFileType,
    chunkStrategy,
    chunkWarnings,
    analysisReadyTextLength: 0,
    sourceConfidence,
    sections,
    ...extra,
  };
}

function finalizeExtraction({ text, metadata }) {
  const normalizedText = normalizeText(text);
  return {
    text: normalizedText,
    metadata: {
      ...metadata,
      extractedTextLength: String(text || '').length,
      analysisReadyTextLength: normalizedText.length,
    },
  };
}

function safeReadFileBuffer(filePath) {
  return fs.readFileSync(filePath);
}

function decodeTextBuffer(buffer) {
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('\uFFFD')) {
    return { text: utf8, warning: null };
  }
  return {
    text: buffer.toString('latin1'),
    warning: 'text_encoding_fallback',
  };
}

function runCommand(file, args, options = {}) {
  return execFileSync(file, args, {
    encoding: options.encoding || 'utf8',
    maxBuffer: options.maxBuffer || 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function buildSection(type, index, title, text, extra = {}) {
  return {
    type,
    index,
    title,
    textLength: String(text || '').length,
    ...extra,
  };
}

module.exports = {
  buildSection,
  createBaseMetadata,
  decodeTextBuffer,
  decodeXmlEntities,
  detectFileType,
  finalizeExtraction,
  normalizeText,
  runCommand,
  safeReadFileBuffer,
};
