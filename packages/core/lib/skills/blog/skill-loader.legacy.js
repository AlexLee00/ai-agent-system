'use strict';

const fs = require('fs');
const path = require('path');

const BLOG_SKILL_DIR = __dirname;

const BLOG_SKILL_FILES = {
  naverSeo: 'naver-seo.md',
  contentQuality: 'content-quality.md',
  bookSearch: 'book-search.md',
  imageGen: 'image-gen.md',
  shortformVideo: 'shortform-video.md',
  blogRag: 'blog-rag.md',
};

function loadBlogSkill(name) {
  const filename = BLOG_SKILL_FILES[name];
  if (!filename) return '';

  try {
    return fs.readFileSync(path.join(BLOG_SKILL_DIR, filename), 'utf8').trim();
  } catch {
    return '';
  }
}

function buildBlogSkillBundle(names = []) {
  const resolved = names
    .map((name) => [name, loadBlogSkill(name)])
    .filter(([, content]) => Boolean(content));

  if (!resolved.length) return '';

  return resolved
    .map(([name, content]) => `[블로그 스킬:${name}]\n${content}`)
    .join('\n\n');
}

module.exports = {
  BLOG_SKILL_FILES,
  loadBlogSkill,
  buildBlogSkillBundle,
};
