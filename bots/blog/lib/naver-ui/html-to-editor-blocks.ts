// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');

function decodeHtml(value = '') {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'");
}

function stripTags(value = '') {
  return decodeHtml(String(value || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function extractAttribute(tag = '', name = '') {
  const pattern = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i');
  return String(tag || '').match(pattern)?.[1] || '';
}

function resolveAssetPath(src = '', htmlFilePath = '') {
  const raw = String(src || '').trim();
  if (!raw || /^https?:\/\//i.test(raw) || raw.startsWith('data:')) return raw;
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(path.dirname(htmlFilePath), raw);
}

function extractTitle(html = '') {
  const h1 = String(html || '').match(/<h1[^>]*class=["'][^"']*post-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  if (h1) return stripTags(h1);
  const title = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return title ? stripTags(title) : '';
}

function extractBodyHtml(html = '') {
  return String(html || '').match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] || String(html || '');
}

function normalizeBodyHtml(body = '') {
  return String(body || '')
    .replace(/<h1[^>]*class=["'][^"']*post-title[^"']*["'][^>]*>[\s\S]*?<\/h1>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
}

function pushTextBlock(blocks, type, text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return;
  const last = blocks[blocks.length - 1];
  if (last?.type === type && last.text === normalized) return;
  blocks.push({ type, text: normalized });
}

function blocksFromHtml(html = '', htmlFilePath = '') {
  const body = normalizeBodyHtml(extractBodyHtml(html));
  const blocks = [];
  const tokenPattern = /<(h2|h3|p|pre)\b[^>]*>[\s\S]*?<\/\1>|<img\b[^>]*\/?>|<br\s*\/?>|<hr\b[^>]*\/?>/gi;
  let match;
  while ((match = tokenPattern.exec(body))) {
    const token = match[0];
    const tag = String(match[1] || '').toLowerCase() || (token.match(/^<(\w+)/i)?.[1] || '').toLowerCase();

    if (tag === 'img') {
      const src = extractAttribute(token, 'src');
      if (src) {
        blocks.push({
          type: 'image',
          src: resolveAssetPath(src, htmlFilePath),
          alt: stripTags(extractAttribute(token, 'alt')),
        });
      }
      continue;
    }

    if (tag === 'br') {
      blocks.push({ type: 'spacer' });
      continue;
    }

    if (tag === 'hr') {
      blocks.push({ type: 'divider' });
      continue;
    }

    const inner = token.replace(/^<[^>]+>/, '').replace(/<\/[^>]+>$/, '');
    if (tag === 'h2' || tag === 'h3') {
      pushTextBlock(blocks, 'heading', stripTags(inner));
      continue;
    }
    if (tag === 'pre') {
      pushTextBlock(blocks, 'code', stripTags(inner));
      continue;
    }
    if (tag === 'p') {
      pushTextBlock(blocks, 'paragraph', stripTags(inner));
    }
  }
  return blocks.filter((block, index, arr) => {
    if (block.type !== 'spacer') return true;
    const prev = arr[index - 1];
    const next = arr[index + 1];
    return prev && next && prev.type !== 'spacer' && next.type !== 'spacer';
  });
}

function buildPlainTextForEditor(blocks = []) {
  const lines = [];
  for (const block of blocks) {
    if (block.type === 'heading') {
      lines.push('', String(block.text || '').trim(), '');
      continue;
    }
    if (block.type === 'paragraph' || block.type === 'code') {
      lines.push(String(block.text || '').trim(), '');
      continue;
    }
    if (block.type === 'divider' || block.type === 'spacer') {
      lines.push('');
    }
  }
  return lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trim();
}

function parseNaverEditorDocumentFromHtml(html = '', htmlFilePath = '') {
  const title = extractTitle(html);
  const blocks = blocksFromHtml(html, htmlFilePath);
  const imagePaths = blocks
    .filter((block) => block.type === 'image')
    .map((block) => block.src)
    .filter(Boolean);
  return {
    title,
    blocks,
    imagePaths,
    plainText: buildPlainTextForEditor(blocks),
    stats: {
      blockCount: blocks.length,
      imageCount: imagePaths.length,
      charCount: buildPlainTextForEditor(blocks).length,
    },
  };
}

function parseNaverEditorDocumentFromFile(filePath = '') {
  const htmlFilePath = path.resolve(String(filePath || ''));
  const html = fs.readFileSync(htmlFilePath, 'utf8');
  return parseNaverEditorDocumentFromHtml(html, htmlFilePath);
}

module.exports = {
  decodeHtml,
  stripTags,
  extractTitle,
  blocksFromHtml,
  buildPlainTextForEditor,
  parseNaverEditorDocumentFromHtml,
  parseNaverEditorDocumentFromFile,
};
