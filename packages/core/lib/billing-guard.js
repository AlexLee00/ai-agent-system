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

const SCOPE_ALIASES = {
  global: 'global',
  luna: 'investment',
  nemesis: 'investment',
  oracle: 'investment',
  argos: 'investment',
  hermes: 'investment',
  sophia: 'investment',
  athena: 'investment',
  zeus: 'investment',
  hephaestos: 'investment',
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
  // 레거시 investment stop 파일은 validation까지 같이 막지 않고
  // normal 레일만 막는 보수적 하위 호환으로 해석한다.
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
  const text = `${data.reason || ''} ${data.activated_by || ''}`;
  if (/\[(luna|nemesis|oracle|argos|hermes|sophia|athena|zeus|hephaestos)\]/i.test(text)) {
    return 'investment';
  }
  return normalizeScope(fallbackScope);
}

function readStopData(scope = 'global') {
  const file = getStopFile(scope);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      ...parsed,
      scope: inferScope(parsed, scope),
      stop_file: file,
    };
  } catch {
    return {
      reason: '알 수 없음',
      scope: normalizeScope(scope),
      stop_file: file,
    };
  }
}

/** 차단 중인지 확인 */
function isBlocked(scope = 'global') {
  return !!getBlockReason(scope);
}

/** 차단 사유 조회 */
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

/** 긴급 차단 활성화 */
function activate(reason, costUsd, activatedBy = 'billing-guard', scope = 'global') {
  const normalized = normalizeScope(scope);
  const stopFile = getStopFile(normalized);
  const data = {
    activated_at:  new Date().toISOString(),
    reason,
    cost_usd:      costUsd,
    activated_by:  activatedBy,
    scope:         normalized,
    release:       `마스터만 해제 가능: rm ${path.basename(stopFile)}`,
  };
  fs.writeFileSync(stopFile, JSON.stringify(data, null, 2));
  console.error(`🚨 [billing-guard] LLM 긴급 차단(${normalized}): ${reason}`);
  return data;
}

/** 차단 해제 (마스터 명령 처리용) */
function deactivate(scope = 'global') {
  const stopFile = getStopFile(scope);
  if (fs.existsSync(stopFile)) {
    fs.unlinkSync(stopFile);
    console.log(`[billing-guard] LLM 긴급 차단 해제 (${normalizeScope(scope)})`);
    return true;
  }
  return false;
}

module.exports = {
  isBlocked,
  getBlockReason,
  activate,
  deactivate,
  normalizeScope,
  scopeMatches,
  getStopFile,
  STOP_FILE,
};
