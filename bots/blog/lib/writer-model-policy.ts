// @ts-nocheck
'use strict';

const DEFAULT_BLOG_WRITER_MODEL = 'anthropic_haiku';

function resolveBlogWriterModel(env = process.env) {
  const raw = String(env?.BLOG_WRITER_MODEL || '').trim();
  return raw || DEFAULT_BLOG_WRITER_MODEL;
}

function writerModelCacheSuffix(model = resolveBlogWriterModel()) {
  return String(model || DEFAULT_BLOG_WRITER_MODEL)
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, '_')
    .slice(0, 80) || DEFAULT_BLOG_WRITER_MODEL;
}

module.exports = {
  DEFAULT_BLOG_WRITER_MODEL,
  resolveBlogWriterModel,
  writerModelCacheSuffix,
};
