'use strict';

/**
 * packages/core/lib/billing-guard.js — LLM 긴급 차단 공통 모듈
 *
 * 파일 기반 차단 플래그:
 *   - global:     .llm-emergency-stop
 *   - scoped:     .llm-emergency-stop.<scope>
 *   - 프로세스 재시작 없이 즉시 적용
 *   - 기본은 global, 필요 시 team/exchange scope 분리 가능
 */

const fs   = require('fs');
const path = require('path');

const STOP_FILE = path.join(__dirname, '../../../.llm-emergency-stop');
const DEFAULT_MARKET_GUARD_TTL_MS = 30 * 60 * 1000;
const DEFAULT_SYMBOL_GUARD_TTL_MS = 15 * 60 * 1000;

const SCOPE_ALIASES = {
  global: 'global',
  luna: 'investment',
  investment: 'investment',
  worker: 'worker',
  blog: 'blog',
  claude: 'claude',
  orchestrator: 'orchestrator',
  reservation: 'reservation',
  ska: 'reservation',
};

function normalizeScope(scope = 'global') {
  const key = String(scope || 'global').trim().toLowerCase();
  return SCOPE_ALIASES[key] || key || 'global';
}

function scopeMatches(targetScope = 'global', actualScope = 'global') {
  const target = normalizeScope(targetScope);
  const actual = normalizeScope(actualScope);
  if (actual === 'global') return target === 'global';
  if (actual === target) return true;
  if (target.startsWith(`${actual}.`)) return true;
  if (actual === 'investment' && target === 'investment.normal') return true;
  if (target === 'investment' && actual.startsWith('investment.')) return true;
  return false;
}

function getStopFile(scope = 'global') {
  const normalized = normalizeScope(scope);
  if (normalized === 'global') return STOP_FILE;
  return `${STOP_FILE}.${normalized}`;
}

function inferScope(data = {}, fallbackScope = 'global') {
  if (data.scope) return normalizeScope(data.scope);
  if (data.team) {
    const teamScope = data.team === 'luna' ? 'investment' : data.team;
    return normalizeScope(teamScope);
  }
  const text = `${data.reason || ''} ${data.activated_by || ''}`;
  if (/\[(luna|investment)\]/i.test(text)) {
    return 'investment';
  }
  return normalizeScope(fallbackScope);
}

function getDefaultAutoTtlMs(scope = 'global') {
  const normalized = normalizeScope(scope);
  const parts = normalized.split('.');
  if (parts[0] !== 'investment') return 0;
  if (parts.length >= 4) return DEFAULT_SYMBOL_GUARD_TTL_MS;
  if (parts.length >= 3) return DEFAULT_MARKET_GUARD_TTL_MS;
  return 0;
}

function resolveExpiresAt(data = {}, scope = 'global') {
  if (data.expires_at) return data.expires_at;
  if (String(data.activated_by || '') !== 'llm-logger') return null;
  const activatedAt = Date.parse(data.activated_at || '');
  if (!Number.isFinite(activatedAt)) return null;
  const ttlMs = getDefaultAutoTtlMs(inferScope(data, scope));
  if (!ttlMs) return null;
  return new Date(activatedAt + ttlMs).toISOString();
}

function readStopData(scope = 'global') {
  const file = getStopFile(scope);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const resolved = {
      ...parsed,
      scope: inferScope(parsed, scope),
      expires_at: resolveExpiresAt(parsed, scope),
      stop_file: file,
    };
    const expiresAtMs = Date.parse(resolved.expires_at || '');
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
      try { fs.unlinkSync(file); } catch {}
      return null;
    }
    return resolved;
  } catch {
    return {
      reason: '알 수 없음',
      scope: normalizeScope(scope),
      stop_file: file,
    };
  }
}

function isBlocked(scope = 'global') {
  return !!getBlockReason(scope);
}

function getBlockReason(scope = 'global') {
  const normalized = normalizeScope(scope);
  const scoped = readStopData(normalized);
  if (scoped) return scoped;

  if (normalized !== 'global') {
    const globalData = readStopData('global');
    if (!globalData) return null;
    if (globalData.scope === 'global') return globalData;
    if (scopeMatches(normalized, globalData.scope)) return globalData;
    return null;
  }

  return readStopData('global');
}

function activate(reason, costUsd, activatedBy = 'billing-guard', scope = 'global', options = {}) {
  const normalized = normalizeScope(scope);
  const stopFile = getStopFile(normalized);
  const ttlMs = Number.isFinite(Number(options.ttlMs)) ? Number(options.ttlMs) : 0;
  const data = {
    activated_at:  new Date().toISOString(),
    reason,
    cost_usd:      costUsd,
    activated_by:  activatedBy,
    scope:         normalized,
    release:       `마스터만 해제 가능: rm ${path.basename(stopFile)}`,
  };
  if (ttlMs > 0) {
    data.expires_at = new Date(Date.now() + ttlMs).toISOString();
  }
  fs.writeFileSync(stopFile, JSON.stringify(data, null, 2));
  console.error(`🚨 [billing-guard] LLM 긴급 차단(${normalized}): ${reason}`);
  return data;
}

function deactivate(scope = 'global') {
  const stopFile = getStopFile(scope);
  if (fs.existsSync(stopFile)) {
    fs.unlinkSync(stopFile);
    console.log(`[billing-guard] LLM 긴급 차단 해제 (${normalizeScope(scope)})`);
    return true;
  }
  return false;
}

function listActiveGuards(scopePrefix = '') {
  const dir = path.dirname(STOP_FILE);
  const base = path.basename(STOP_FILE);
  const normalizedPrefix = scopePrefix ? normalizeScope(scopePrefix) : '';
  const entries = fs.readdirSync(dir).filter((name) => name === base || name.startsWith(`${base}.`));
  const rows = [];

  for (const entry of entries) {
    const scope = entry === base ? 'global' : entry.slice(`${base}.`.length);
    const data = readStopData(scope);
    if (!data) continue;
    const actualScope = normalizeScope(data.scope || scope);
    if (normalizedPrefix && actualScope !== normalizedPrefix && !actualScope.startsWith(`${normalizedPrefix}.`)) {
      continue;
    }
    rows.push(data);
  }

  return rows.sort((a, b) => String(a.scope || '').localeCompare(String(b.scope || ''), 'ko'));
}

module.exports = {
  isBlocked,
  getBlockReason,
  activate,
  deactivate,
  listActiveGuards,
  normalizeScope,
  scopeMatches,
  getStopFile,
  getDefaultAutoTtlMs,
  STOP_FILE,
};
