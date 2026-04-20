'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');

const BLOG_ROOT = path.join(env.PROJECT_ROOT, 'bots/blog');
const SHORTFORM_DIR = path.join(BLOG_ROOT, 'output/shortform');
const IMAGE_DIR = path.join(BLOG_ROOT, 'output/images');

function slugify(text = '') {
  return String(text)
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

function tokenizeKoreanTitle(text = '') {
  return String(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/gu)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
}

/**
 * @param {string} dirPath
 * @param {((name: string) => boolean) | null} [predicate]
 * @returns {string[]}
 */
function listFilesSortedByMtime(dirPath, predicate = null) {
  if (!fs.existsSync(dirPath)) return [];
  const matcher = typeof predicate === 'function' ? predicate : (() => true);
  return fs
    .readdirSync(dirPath)
    .filter((name) => matcher(name))
    .map((name) => path.join(dirPath, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

/** @returns {string | null} */
function findLatestReelPath() {
  const files = listFilesSortedByMtime(SHORTFORM_DIR, (name) => name.endsWith('_reel.mp4'));
  return files[0] || null;
}

/** @returns {string | null} */
function findReelPathForTitle(title = '') {
  const slug = slugify(title);
  if (!slug || !fs.existsSync(SHORTFORM_DIR)) return null;
  const exact = path.join(SHORTFORM_DIR, `${slug}_reel.mp4`);
  if (fs.existsSync(exact)) return exact;
  const files = listFilesSortedByMtime(
    SHORTFORM_DIR,
    (name) => name.endsWith('_reel.mp4') && name.includes(slug)
  );
  return files[0] || null;
}

/** @returns {string | null} */
function findLatestThumbPath() {
  const files = listFilesSortedByMtime(IMAGE_DIR, (name) => name.endsWith('_thumb.png'));
  return files[0] || null;
}

/** @returns {string | null} */
function findThumbPathForTitle(title = '') {
  const slug = slugify(title);
  if (!slug || !fs.existsSync(IMAGE_DIR)) return null;
  const exact = path.join(IMAGE_DIR, `${slug}_thumb.png`);
  if (fs.existsSync(exact)) return exact;
  const queryTokens = tokenizeKoreanTitle(title);
  const files = listFilesSortedByMtime(IMAGE_DIR, (name) => name.endsWith('_thumb.png'));
  const scored = files
    .map((fullPath) => {
      const base = path.basename(fullPath).replace(/_thumb\.png$/i, '');
      const normalized = slugify(base);
      const baseTokens = tokenizeKoreanTitle(base);
      let score = 0;
      if (normalized.includes(slug) || slug.includes(normalized)) score += 100;
      for (const token of queryTokens) {
        if (normalized.includes(token)) score += 10;
        if (baseTokens.includes(token)) score += 4;
      }
      return { fullPath, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || fs.statSync(b.fullPath).mtimeMs - fs.statSync(a.fullPath).mtimeMs);
  return scored[0]?.fullPath || null;
}

module.exports = {
  BLOG_ROOT,
  SHORTFORM_DIR,
  IMAGE_DIR,
  listFilesSortedByMtime,
  findLatestReelPath,
  findReelPathForTitle,
  findLatestThumbPath,
  findThumbPathForTitle,
};
