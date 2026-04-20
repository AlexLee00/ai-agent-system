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

module.exports = {
  BLOG_ROOT,
  SHORTFORM_DIR,
  IMAGE_DIR,
  listFilesSortedByMtime,
  findLatestReelPath,
  findReelPathForTitle,
  findLatestThumbPath,
};
