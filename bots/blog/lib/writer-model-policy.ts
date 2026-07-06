// @ts-nocheck
'use strict';

const DEFAULT_BLOG_WRITER_MODEL = 'anthropic_haiku';
const WRITER_MODEL_FAMILIES = new Set(['anthropic', 'openai', 'gemini', 'groq', 'local']);

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

function isBlogAbStrictFamilyEnabled(env = process.env) {
  return String(env?.BLOG_AB_STRICT_FAMILY || '').trim().toLowerCase() === 'true';
}

function writerModelFamily(model = resolveBlogWriterModel()) {
  const value = String(model || '').trim().toLowerCase();
  if (value.startsWith('anthropic_') || value.startsWith('claude') || value.startsWith('claude-code/')) return 'anthropic';
  if (value.startsWith('openai_') || value.startsWith('openai') || value.startsWith('gpt')) return 'openai';
  if (value.startsWith('gemini') || value.startsWith('google-gemini')) return 'gemini';
  if (value.startsWith('groq')) return 'groq';
  if (value.startsWith('local')) return 'local';
  return '';
}

function buildWriterFamilyRequestOptions(model = resolveBlogWriterModel(), env = process.env) {
  if (!isBlogAbStrictFamilyEnabled(env)) return {};
  const family = writerModelFamily(model);
  if (!WRITER_MODEL_FAMILIES.has(family)) return {};
  return { strictProviderFamily: family };
}

module.exports = {
  DEFAULT_BLOG_WRITER_MODEL,
  resolveBlogWriterModel,
  writerModelCacheSuffix,
  isBlogAbStrictFamilyEnabled,
  writerModelFamily,
  buildWriterFamilyRequestOptions,
};
