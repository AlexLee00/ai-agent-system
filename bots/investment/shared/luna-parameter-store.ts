// @ts-nocheck

import * as db from './db.ts';
import { getParameterGovernance } from './runtime-parameter-governance.ts';

const VALID_SCOPES = new Set(['global', 'market', 'strategy_family']);
const VALID_CHANGED_BY = new Set(['system', 'meeting', 'master']);
const DEFAULT_CACHE_TTL_MS = 30_000;

let cacheExpiresAt = 0;
const parameterCache = new Map<string, any>();

function nowMs() {
  return Date.now();
}

function cacheKey(key: string, scope: string) {
  return `${scope}:${key}`;
}

function normalizeScope(scope: unknown = 'global') {
  const value = String(scope || 'global').trim() || 'global';
  if (!VALID_SCOPES.has(value)) {
    throw new Error(`invalid_luna_parameter_scope:${value}`);
  }
  return value;
}

function normalizeChangedBy(changedBy: unknown = 'system') {
  const value = String(changedBy || 'system').trim() || 'system';
  if (!VALID_CHANGED_BY.has(value)) {
    throw new Error(`invalid_luna_parameter_changed_by:${value}`);
  }
  return value;
}

function cacheTtlMs(env = process.env) {
  const raw = Number(env.LUNA_PARAMETER_STORE_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_CACHE_TTL_MS;
}

function parseMaybeJson(value: string) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  try {
    return JSON.parse(trimmed);
  } catch {
    if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) && trimmed !== '' ? numeric : trimmed;
  }
}

function keyToEnvCandidates(key: string) {
  const snake = String(key || '')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return [key, snake, `LUNA_PARAM_${snake}`].filter(Boolean);
}

function envFallback(key: string, scope: string, env = process.env) {
  for (const envKey of keyToEnvCandidates(key)) {
    if (Object.prototype.hasOwnProperty.call(env, envKey)) {
      return {
        key,
        value: parseMaybeJson(env[envKey]),
        scope,
        tier: 'auto',
        effectiveFrom: null,
        evidence: `env:${envKey}`,
        changedBy: 'system',
        source: 'env',
      };
    }
  }
  return null;
}

function governanceToStoreTier(governance: any, requestedTier?: string | null) {
  const governanceTier = String(governance?.tier || '').trim();
  if (governanceTier === 'block') return 'immutable';
  if (governanceTier === 'escalate') return 'approve';
  if (requestedTier && ['auto', 'approve', 'immutable'].includes(String(requestedTier))) {
    return String(requestedTier);
  }
  return 'auto';
}

function normalizeRow(row: any, source = 'store') {
  if (!row) return null;
  return {
    key: row.key,
    value: row.value,
    scope: row.scope || 'global',
    tier: row.tier || 'auto',
    effectiveFrom: row.effective_from || row.effectiveFrom || null,
    evidence: row.evidence || null,
    changedBy: row.changed_by || row.changedBy || null,
    createdAt: row.created_at || row.createdAt || null,
    source,
  };
}

async function loadLatestStoredParameter(key: string, scope: string, effectiveAt = new Date(), queryFn = db.query) {
  const rows = await queryFn(
    `SELECT key, value, scope, tier, effective_from, evidence, changed_by, created_at
       FROM luna_parameter_store
      WHERE key = $1
        AND scope = $2
        AND effective_from <= $3
      ORDER BY effective_from DESC, created_at DESC, id DESC
      LIMIT 1`,
    [key, scope, effectiveAt]
  );
  return normalizeRow(rows?.[0] || null, 'store');
}

export function reloadParameters() {
  parameterCache.clear();
  cacheExpiresAt = 0;
}

export async function getParameter(key: string, scope: string = 'global', options: any = {}) {
  const parameterKey = String(key || '').trim();
  if (!parameterKey) throw new Error('luna_parameter_key_required');
  const normalizedScope = normalizeScope(scope);
  const ttl = cacheTtlMs(options.env || process.env);
  const now = nowMs();
  const cKey = cacheKey(parameterKey, normalizedScope);
  if (!options.bypassCache && ttl > 0 && now < cacheExpiresAt && parameterCache.has(cKey)) {
    return parameterCache.get(cKey);
  }

  const effectiveAt = options.effectiveAt ? new Date(options.effectiveAt) : new Date();
  const stored = await loadLatestStoredParameter(parameterKey, normalizedScope, effectiveAt, options.queryFn || db.query);
  const value = stored || envFallback(parameterKey, normalizedScope, options.env || process.env) || null;

  if (ttl > 0) {
    parameterCache.set(cKey, value);
    cacheExpiresAt = now + ttl;
  }
  return value;
}

export async function setParameter(input: any = {}, deps: any = {}) {
  const key = String(input.key || '').trim();
  if (!key) throw new Error('luna_parameter_key_required');
  const scope = normalizeScope(input.scope || 'global');
  const changedBy = normalizeChangedBy(input.changedBy || input.changed_by || 'system');
  const governance = deps.getParameterGovernance
    ? deps.getParameterGovernance(key)
    : getParameterGovernance(key);
  const tier = governanceToStoreTier(governance, input.tier);

  if (tier === 'immutable') {
    throw new Error(`luna_parameter_immutable:${key}`);
  }
  if (tier === 'approve' && !['master', 'meeting'].includes(changedBy)) {
    throw new Error(`luna_parameter_approval_required:${key}`);
  }

  const queryFn = deps.queryFn || db.query;
  const runFn = deps.runFn || db.run;
  const effectiveFrom = input.effectiveFrom || input.effective_from || new Date();
  const prev = await loadLatestStoredParameter(key, scope, new Date(effectiveFrom), queryFn);
  const prevValue = prev ? prev.value : null;
  const evidence = input.evidence || null;
  const value = input.value;

  const result = await runFn(
    `INSERT INTO luna_parameter_store
       (key, value, scope, tier, effective_from, evidence, changed_by, prev_value)
     VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8::jsonb)
     RETURNING key, value, scope, tier, effective_from, evidence, changed_by, created_at`,
    [
      key,
      JSON.stringify(value),
      scope,
      tier,
      effectiveFrom,
      evidence,
      changedBy,
      prevValue == null ? null : JSON.stringify(prevValue),
    ]
  );
  reloadParameters();
  return normalizeRow(result?.rows?.[0] || null, 'store');
}

export async function listParameterHistory(key: string, scope: string = 'global', options: any = {}) {
  const parameterKey = String(key || '').trim();
  if (!parameterKey) throw new Error('luna_parameter_key_required');
  const normalizedScope = normalizeScope(scope);
  const rows = await (options.queryFn || db.query)(
    `SELECT key, value, scope, tier, effective_from, evidence, changed_by, prev_value, created_at
       FROM luna_parameter_store
      WHERE key = $1
        AND scope = $2
      ORDER BY effective_from DESC, created_at DESC, id DESC`,
    [parameterKey, normalizedScope]
  );
  return (rows || []).map((row: any) => normalizeRow(row, 'store'));
}

export const _testOnly = {
  normalizeScope,
  governanceToStoreTier,
  keyToEnvCandidates,
  parseMaybeJson,
};

export default {
  getParameter,
  setParameter,
  listParameterHistory,
  reloadParameters,
};
