'use strict';

/**
 * checks/workspace-git.js — 프로젝트 Git 무결성 점검
 *
 * 점검 항목:
 *   1. uncommitted 변경사항 유무 (10파일 초과 → warn)
 *   2. 마지막 커밋 시각 (24시간 초과 → info 수준 warn)
 *   3. 핵심 파일 존재 (CLAUDE.md, package.json, .gitignore)
 *   4. .gitignore에 secrets 패턴 포함 확인
 *   5. 절대규칙 위반 가능성: secrets.json 파일이 스테이징됐는지 확인
 */

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..', '..', '..', '..');

const GENERATED_PATH_PATTERNS = [
  /^bots\/video\/temp\//,
  /^bots\/worker\/web\/\.next\//,
  /^bots\/worker\/web\/\.next_bak_/,
  /^tmp\//,
  /^sync_map\.json$/,
  /^=$/,
];

// 핵심 파일 존재 여부 점검 대상
const CRITICAL_FILES = [
  'CLAUDE.md',
  'package.json',
  '.gitignore',
];

// .gitignore에 반드시 포함돼야 할 패턴
const SECRETS_PATTERNS = ['secrets', '*.key', 'api_key', '.env'];

// ── git 명령 실행 헬퍼 ─────────────────────────────────────────────

function git(cmd, timeoutMs = 8000) {
  try {
    return execSync(`git -C "${PROJECT_ROOT}" ${cmd}`, {
      encoding: 'utf8',
      timeout:  timeoutMs,
    }).trim();
  } catch {
    return null;
  }
}

function parseChangedPath(line) {
  if (!line || line.length < 4) return '';
  return line.slice(3).trim().replace(/^"(.*)"$/, '$1');
}

function isGeneratedPath(filePath) {
  return GENERATED_PATH_PATTERNS.some((pattern) => pattern.test(filePath));
}

// ── 메인 run ──────────────────────────────────────────────────────

async function run() {
  const items = [];

  // git 저장소 여부 확인
  const isGitRepo = fs.existsSync(path.join(PROJECT_ROOT, '.git'));
  if (!isGitRepo) {
    items.push({ label: 'Git 저장소', status: 'warn', detail: '.git 디렉토리 없음 — git 초기화 확인' });
    return { name: 'Git 무결성', status: 'warn', items };
  }

  // 1. uncommitted 변경사항
  const statusOut = git('status --porcelain');
  if (statusOut === null) {
    items.push({ label: 'Git 상태', status: 'warn', detail: 'git status 실행 실패' });
  } else {
    const changedLines = statusOut ? statusOut.split('\n').filter(Boolean) : [];
    const changedPaths = changedLines.map(parseChangedPath).filter(Boolean);
    const generatedPaths = changedPaths.filter(isGeneratedPath);
    const meaningfulPaths = changedPaths.filter((filePath) => !isGeneratedPath(filePath));

    // 절대규칙 위반 감지: secrets.json이 스테이징됐는지 확인
    const secretsStaged = changedLines.some(l => /secrets\.json/.test(l) && !l.startsWith('??'));
    if (secretsStaged) {
      items.push({
        label:  'Git 보안 위반',
        status: 'error',
        detail: 'secrets.json이 스테이징됨 — 절대 커밋 금지! git reset HEAD secrets.json 실행 필요',
      });
    }

    if (generatedPaths.length > 0) {
      items.push({
        label: 'Git 생성 산출물',
        status: 'ok',
        detail: `${generatedPaths.length}개 파일은 temp/build/backup 산출물로 분리 관찰`,
      });
    }

    if (meaningfulPaths.length === 0) {
      items.push({ label: 'Git 변경사항', status: 'ok', detail: '변경 없음 (clean)' });
    } else if (meaningfulPaths.length > 10) {
      items.push({
        label:  'Git 변경사항',
        status: 'warn',
        detail: `${meaningfulPaths.length}개 파일 uncommitted — 커밋 또는 정리 권장`,
      });
    } else {
      items.push({
        label:  'Git 변경사항',
        status: 'ok',
        detail: `${meaningfulPaths.length}개 파일 미커밋 (${meaningfulPaths.length}건)`,
      });
    }
  }

  // 2. 마지막 커밋 시각
  const lastCommitTs = git('log -1 --format=%ct');
  if (lastCommitTs) {
    const tsMs    = parseInt(lastCommitTs, 10) * 1000;
    const hoursAgo = (Date.now() - tsMs) / 3600000;
    const lastMsg  = git('log -1 --format=%s') || '';

    if (hoursAgo > 72) {
      items.push({
        label:  '마지막 커밋',
        status: 'warn',
        detail: `${Math.round(hoursAgo)}시간 전 — "${lastMsg.slice(0, 40)}"`,
      });
    } else {
      items.push({
        label:  '마지막 커밋',
        status: 'ok',
        detail: `${Math.round(hoursAgo)}시간 전 — "${lastMsg.slice(0, 40)}"`,
      });
    }
  }

  // 3. 핵심 파일 존재
  for (const f of CRITICAL_FILES) {
    const exists = fs.existsSync(path.join(PROJECT_ROOT, f));
    items.push({
      label:  `핵심 파일: ${f}`,
      status: exists ? 'ok' : 'error',
      detail: exists ? '존재' : '파일 없음 — 복구 필요',
    });
  }

  // 4. .gitignore 보안 패턴 확인
  const gitignorePath = path.join(PROJECT_ROOT, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf8').toLowerCase();
    const missing  = SECRETS_PATTERNS.filter(p => !content.includes(p.toLowerCase()));

    if (missing.length > 0) {
      items.push({
        label:  '.gitignore 보안',
        status: 'warn',
        detail: `누락 패턴: ${missing.join(', ')} — secrets 노출 위험`,
      });
    } else {
      items.push({
        label:  '.gitignore 보안',
        status: 'ok',
        detail: 'secrets 패턴 포함 확인',
      });
    }
  }

  const hasError = items.some(i => i.status === 'error');
  const hasWarn  = items.some(i => i.status === 'warn');

  return {
    name:   'Git 무결성',
    status: hasError ? 'error' : hasWarn ? 'warn' : 'ok',
    items,
  };
}

module.exports = { run };
