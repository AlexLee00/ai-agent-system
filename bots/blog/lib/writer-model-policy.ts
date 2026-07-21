// @ts-nocheck
'use strict';

const DEFAULT_BLOG_WRITER_MODEL = 'anthropic_haiku';
const BLOG_WRITER_ROTATION_POLICY = 'daily-post-type-checkerboard-v1';
const BLOG_WRITER_ROTATION_ANCHOR = '2026-07-21';
const BLOG_WRITER_ROTATION_MODELS = Object.freeze(['anthropic_sonnet', 'anthropic_haiku']);
const WRITER_MODEL_FAMILIES = new Set(['anthropic', 'openai', 'groq', 'local']);

function resolveBlogWriterModel(env = process.env) {
  const raw = String(env?.BLOG_WRITER_MODEL || '').trim();
  return raw || DEFAULT_BLOG_WRITER_MODEL;
}

function normalizePublicationDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  }
  const match = String(value || '').trim().match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) return '';
  const [year, month, day] = match[1].split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  const valid = parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
  return valid ? match[1] : '';
}

function buildFrozenAssignment(fields) {
  const tag = `${fields.policy}|${fields.unit || 'unassigned'}|${fields.model}`;
  return Object.freeze({ ...fields, tag });
}

function resolveBlogWriterAssignment(input = {}, env = process.env) {
  const publishDate = normalizePublicationDate(input.publishDate || input.publish_date);
  const postType = String(input.postType || input.post_type || '').trim().toLowerCase();
  const validPostType = postType === 'lecture' || postType === 'general';
  const unit = publishDate && validPostType ? `${publishDate}:${postType}` : null;
  const override = String(env?.BLOG_WRITER_MODEL || '').trim();

  if (override) {
    return buildFrozenAssignment({
      policy: 'fixed-env-v1',
      unit,
      block: publishDate || null,
      stratum: validPostType ? postType : null,
      source: 'env_override',
      slot: null,
      model: override,
    });
  }

  if (!publishDate || !validPostType) {
    return buildFrozenAssignment({
      policy: 'identity-fallback-v1',
      unit: null,
      block: publishDate || null,
      stratum: validPostType ? postType : null,
      source: 'identity_fallback',
      slot: null,
      model: DEFAULT_BLOG_WRITER_MODEL,
    });
  }

  const anchor = Date.parse(`${BLOG_WRITER_ROTATION_ANCHOR}T00:00:00Z`);
  const current = Date.parse(`${publishDate}T00:00:00Z`);
  const daysSinceAnchor = Math.round((current - anchor) / 86_400_000);
  const stratumOffset = postType === 'general' ? 1 : 0;
  const slot = ((daysSinceAnchor + stratumOffset) % 2 + 2) % 2;
  return buildFrozenAssignment({
    policy: BLOG_WRITER_ROTATION_POLICY,
    unit,
    block: publishDate,
    stratum: postType,
    source: 'rotation',
    slot,
    model: BLOG_WRITER_ROTATION_MODELS[slot],
  });
}

function resolveBlogWriterModelForAssignment(assignment, env = process.env) {
  const assignedModel = String(assignment?.model || '').trim();
  return assignedModel || resolveBlogWriterModel(env);
}

function isRotationExperimentAssignment(assignment) {
  return assignment?.policy === BLOG_WRITER_ROTATION_POLICY
    && assignment?.source === 'rotation'
    && Boolean(String(assignment?.unit || '').trim());
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
  BLOG_WRITER_ROTATION_ANCHOR,
  BLOG_WRITER_ROTATION_MODELS,
  BLOG_WRITER_ROTATION_POLICY,
  DEFAULT_BLOG_WRITER_MODEL,
  isRotationExperimentAssignment,
  resolveBlogWriterAssignment,
  resolveBlogWriterModel,
  resolveBlogWriterModelForAssignment,
  writerModelCacheSuffix,
  isBlogAbStrictFamilyEnabled,
  writerModelFamily,
  buildWriterFamilyRequestOptions,
};
