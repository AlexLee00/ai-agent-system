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

function extractCategoryFromThumbName(fileName = '') {
  const match = String(fileName).match(/general__([^_]+(?:와App|IT트렌드|정보와분석|개발기획과컨설팅|성장과성공|도서리뷰|자기계발)?)/);
  return match ? match[1] : '';
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
function findLatestReelCoverPath() {
  const files = listFilesSortedByMtime(SHORTFORM_DIR, (name) => name.endsWith('_reel_cover.jpg'));
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
function findReelCoverPathForTitle(title = '') {
  const slug = slugify(title);
  if (!slug || !fs.existsSync(SHORTFORM_DIR)) return null;
  const exact = path.join(SHORTFORM_DIR, `${slug}_reel_cover.jpg`);
  if (fs.existsSync(exact)) return exact;
  const files = listFilesSortedByMtime(
    SHORTFORM_DIR,
    (name) => name.endsWith('_reel_cover.jpg') && name.includes(slug)
  );
  return files[0] || null;
}

/** @returns {string | null} */
function findLatestThumbPath() {
  const files = listFilesSortedByMtime(IMAGE_DIR, (name) => name.endsWith('_thumb.png'));
  return files[0] || null;
}

/** @returns {string | null} */
function findThumbPathForTitle(title = '', category = '', options = {}) {
  return selectThumbForTitle(title, category, options)?.path || null;
}

/** @returns {{ path: string, score: number, matchType: string } | null} */
function selectThumbForTitle(title = '', category = '', options = {}) {
  const purpose = String(options.purpose || 'default');
  const slug = slugify(title);
  if (!slug || !fs.existsSync(IMAGE_DIR)) return null;
  const exact = path.join(IMAGE_DIR, `${slug}_thumb.png`);
  if (fs.existsSync(exact)) {
    return { path: exact, score: 999, matchType: 'exact' };
  }
  const queryTokens = tokenizeKoreanTitle(title);
  const categoryToken = String(category || '').trim();
  const files = listFilesSortedByMtime(IMAGE_DIR, (name) => name.endsWith('_thumb.png'));
  const scored = files
    .map((fullPath) => {
      const base = path.basename(fullPath).replace(/_thumb\.png$/i, '');
      const normalized = slugify(base);
      const baseTokens = tokenizeKoreanTitle(base);
      const thumbCategory = extractCategoryFromThumbName(base);
      let score = 0;
      let matchType = 'token';
      let tokenHits = 0;
      if (normalized.includes(slug) || slug.includes(normalized)) {
        score += 100;
        matchType = 'slug';
      }
      if (categoryToken && thumbCategory === categoryToken) {
        score += 30;
        matchType = matchType === 'slug' ? matchType : 'category';
      } else if (categoryToken && thumbCategory && thumbCategory !== categoryToken) {
        score -= 20;
      }
      for (const token of queryTokens) {
        if (normalized.includes(token)) {
          score += 10;
          tokenHits += 1;
        }
        if (baseTokens.includes(token)) {
          score += 4;
          tokenHits += 1;
        }
      }
      return { fullPath, score, matchType, thumbCategory, tokenHits };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || fs.statSync(b.fullPath).mtimeMs - fs.statSync(a.fullPath).mtimeMs);
  const best = scored[0];
  if (!best || best.score < 24) return null;
  if (best.matchType !== 'slug' && best.tokenHits < 2) return null;
  if (categoryToken && best.thumbCategory && best.thumbCategory !== categoryToken) return null;
  if (purpose === 'reel') {
    if (best.matchType === 'category') return null;
    if (best.matchType !== 'slug' && best.tokenHits < 4) return null;
    if (best.score < 42) return null;
  }
  return { path: best.fullPath, score: best.score, matchType: best.matchType };
}

module.exports = {
  BLOG_ROOT,
  SHORTFORM_DIR,
  IMAGE_DIR,
  listFilesSortedByMtime,
  findLatestReelPath,
  findLatestReelCoverPath,
  findReelPathForTitle,
  findReelCoverPathForTitle,
  findLatestThumbPath,
  findThumbPathForTitle,
  selectThumbForTitle,
};
