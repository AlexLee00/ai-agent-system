// @ts-nocheck
'use strict';

/**
 * checks/code.js — 코드 무결성 체크
 * - 핵심 파일 SHA256 체크섬 (변경 감지)
 * - git 상태 (uncommitted 변경)
 * - 문법 오류 (node --check)
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const cfg    = require('../config');

const CHECKSUM_FILE = path.join(cfg.BOTS.claude, '.checksums.json');
const GENERATED_PATH_PATTERNS = [
  /^bots\/video\/temp\//,
  /^bots\/worker\/web\/\.next\//,
  /^bots\/worker\/web\/\.next_bak_/,
  /^tmp\//,
  /^sync_map\.json$/,
  /^=$/,
];

function sha256(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

function loadChecksums() {
  try { return JSON.parse(fs.readFileSync(CHECKSUM_FILE, 'utf8')); }
  catch { return {}; }
}

function saveChecksums(map) {
  fs.writeFileSync(CHECKSUM_FILE, JSON.stringify(map, null, 2));
}

function parseChangedPath(line) {
  if (!line || line.length < 4) return '';
  return line.slice(3).trim().replace(/^"(.*)"$/, '$1');
}

function isGeneratedPath(filePath) {
  return GENERATED_PATH_PATTERNS.some((pattern) => pattern.test(filePath));
}

/**
 * 체크섬 베이스라인을 현재 파일 상태로 갱신
 * 코드 업데이트 후 의도적으로 실행 (--update-checksums)
 */
function updateChecksums() {
  const current = {};
  const missing = [];

  for (const rel of cfg.CRITICAL_FILES) {
    const abs  = path.join(cfg.ROOT, rel);
    const hash = sha256(abs);
    if (hash) {
      current[rel] = hash;
    } else {
      missing.push(rel);
    }
  }

  saveChecksums(current);
  return { updated: Object.keys(current).length, missing };
}

async function run() {
  const items  = [];
  const stored = loadChecksums();
  const current = {};
  let changed = 0;
  let missingBaseline = 0;

  // 1. 핵심 파일 체크섬 비교 (초기 베이스라인 없으면 현재 상태를 저장)
  const isFirstRun = Object.keys(stored).length === 0;

  for (const rel of cfg.CRITICAL_FILES) {
    const abs  = path.join(cfg.ROOT, rel);
    const hash = sha256(abs);

    if (!hash) {
      items.push({ label: rel, status: 'warn', detail: '파일 없음' });
      continue;
    }

    current[rel] = hash;

    if (!isFirstRun && !stored[rel]) {
      missingBaseline++;
      items.push({
        label: rel,
        status: 'warn',
        detail: '체크섬 베이스라인 없음 — --update-checksums 실행 필요',
      });
    } else if (!isFirstRun && stored[rel] && stored[rel] !== hash) {
      changed++;

      // 마지막 git 커밋 확인 — Claude Code 외 수정이면 CRITICAL
      let commitInfo = '';
      let isSuspicious = false;
      try {
        const log = execSync(
          `git -C "${cfg.ROOT}" log --oneline -1 -- "${rel}"`,
          { encoding: 'utf8', timeout: 5000, shell: '/bin/zsh' }
        ).trim();
        commitInfo = log || '(커밋 없음 — 미커밋 수정)';
        // 커밋이 없으면 → 봇이 직접 수정한 가능성 (가장 위험)
        if (!log) isSuspicious = true;
      } catch {
        commitInfo = '(git 조회 실패)';
      }

      const status = isSuspicious ? 'error' : 'warn';
      const prefix = isSuspicious ? '🚨 무단 수정 의심' : '체크섬 변경 감지';
      items.push({
        label:  rel,
        status,
        detail: `${prefix} (이전: ${stored[rel].slice(0,8)}… → 현재: ${hash.slice(0,8)}…) | 마지막 커밋: ${commitInfo}`,
      });
    } else {
      items.push({ label: rel, status: 'ok', detail: hash.slice(0, 12) + '…' });
    }
  }

  // 첫 실행 시만 베이스라인 저장 (이후엔 --update-checksums으로만 갱신)
  if (isFirstRun) saveChecksums(current);

  if (changed === 0 && missingBaseline === 0) {
    items.unshift({ label: '체크섬', status: 'ok', detail: `핵심 파일 ${cfg.CRITICAL_FILES.length}개 무결` });
  } else {
    const suspicious = items.filter(i => i.status === 'error').length;
    const summary = suspicious > 0
      ? `🚨 ${suspicious}개 무단 수정 의심 (미커밋), ${changed}개 변경, ${missingBaseline}개 베이스라인 누락`
      : `${changed}개 파일 변경, ${missingBaseline}개 베이스라인 누락`;
    items.unshift({ label: '체크섬', status: suspicious > 0 ? 'error' : 'warn', detail: summary });
  }

  // 2. git 상태 (출력 제한으로 타임아웃 방지)
  try {
    const dirty = execSync('git -C "' + cfg.ROOT + '" status --porcelain | head -200', { encoding: 'utf8', timeout: 15000, shell: '/bin/zsh' }).trim();
    const lines = dirty ? dirty.split('\n').filter(Boolean) : [];
    const paths = lines.map(parseChangedPath).filter(Boolean);
    const meaningfulPaths = paths.filter((filePath) => !isGeneratedPath(filePath));
    if (meaningfulPaths.length === 0) {
      items.push({ label: 'git 상태', status: 'ok', detail: '변경 없음 (clean)' });
    } else {
      const suffix = meaningfulPaths.length >= 200 ? ' (일부)' : '';
      items.push({ label: 'git 상태', status: 'warn', detail: `미커밋 변경 ${meaningfulPaths.length}개${suffix}` });
    }
  } catch {
    items.push({ label: 'git 상태', status: 'warn', detail: 'git 조회 실패' });
  }

  // 3. 주요 JS 파일 문법 체크
  const jsTargets = cfg.CRITICAL_FILES.filter(f => f.endsWith('.js'));
  let syntaxErrors = 0;
  for (const rel of jsTargets) {
    const abs = path.join(cfg.ROOT, rel);
    try {
      execSync(`"${process.execPath}" --check "${abs}"`, { timeout: 5000, stdio: 'pipe' });
    } catch (e) {
      syntaxErrors++;
      items.push({ label: `문법: ${path.basename(rel)}`, status: 'error', detail: e.stderr?.toString().slice(0, 120) || '문법 오류' });
    }
  }
  if (syntaxErrors === 0) {
    items.push({ label: '문법 검사', status: 'ok', detail: `JS ${jsTargets.length}개 이상 없음` });
  }

  const hasError = items.some(i => i.status === 'error');
  const hasWarn  = items.some(i => i.status === 'warn');

  return {
    name:   '코드 무결성',
    status: hasError ? 'error' : hasWarn ? 'warn' : 'ok',
    items,
  };
}

module.exports = { run, updateChecksums };
