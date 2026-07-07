// @ts-nocheck

import crypto from 'node:crypto';

export const SIGMA_TIME_STAGES = ['raw', 'digest', 'pattern', 'dormant', 'forgotten'];
export const SIGMA_LEGACY_TIME_STAGE_MAP = {
  decayed: 'dormant',
};

export function normalizeTextForDigest(value = '') {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function sigmaContentMd5({ title = '', content = '' } = {}) {
  return crypto
    .createHash('md5')
    .update(`${normalizeTextForDigest(title)}\n${normalizeTextForDigest(content)}`)
    .digest('hex');
}

export function safeJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

export function normalizeTimeStage(value = 'raw') {
  const raw = String(value || '').trim();
  const mapped = SIGMA_LEGACY_TIME_STAGE_MAP[raw] || raw;
  return SIGMA_TIME_STAGES.includes(mapped) ? mapped : 'raw';
}

export function ageDays(createdAt, now = new Date()) {
  const date = createdAt instanceof Date ? createdAt : new Date(String(createdAt || now.toISOString()));
  const millis = Number.isFinite(date.getTime()) ? now.getTime() - date.getTime() : 0;
  return Math.max(0, millis / 86400_000);
}

export function initialTimeStageFromAge(createdAt, now = new Date()) {
  const days = ageDays(createdAt, now);
  if (days < 7) return 'raw';
  if (days < 30) return 'digest';
  return 'dormant';
}

export function nextDecayStage(stage) {
  const current = normalizeTimeStage(stage);
  if (current === 'raw') return 'digest';
  if (current === 'digest') return 'pattern';
  if (current === 'pattern') return 'dormant';
  if (current === 'dormant') return 'forgotten';
  return null;
}

export function recallStage(stage) {
  const current = normalizeTimeStage(stage);
  if (current === 'forgotten') return 'dormant';
  if (current === 'dormant') return 'pattern';
  return null;
}

export function mergeLibraryCoords(meta = {}, coords = {}) {
  const current = safeJson(meta);
  return {
    ...current,
    libraryCoords: {
      ...(current.libraryCoords || {}),
      ...coords,
    },
  };
}

export function rowsFromPg(result) {
  return Array.isArray(result) ? result : result?.rows || [];
}
