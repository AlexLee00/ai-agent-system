// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../../../..');

function fileExists(relativePath) {
  try {
    return fs.existsSync(path.join(ROOT, relativePath));
  } catch {
    return false;
  }
}

function checkClaudeFile(relativePath) {
  const issues = [];
  const parts = relativePath.split('/');
  const teamDir = parts.length >= 3 ? `${parts[0]}/${parts[1]}` : null;
  if (!teamDir) return issues;

  const claudePath = `${teamDir}/CLAUDE.md`;
  if (!fileExists(claudePath)) {
    issues.push({
      file: relativePath,
      doc: claudePath,
      issue: '팀 CLAUDE.md 부재',
      suggestion: `${claudePath}에 핵심 파일/역할 설명 초안 추가 필요`,
    });
  }
  return issues;
}

function checkCoreFile(relativePath) {
  if (!relativePath.startsWith('packages/core/lib/')) return [];
  const doc = 'packages/core/CLAUDE.md';
  if (fileExists(doc)) return [];
  return [{
    file: relativePath,
    doc,
    issue: 'core 공용 문서 부재',
    suggestion: 'packages/core/CLAUDE.md 신설 또는 공용 모듈 목록 갱신 필요',
  }];
}

function checkTracker(relativePath) {
  if (!/(^bots\/|^packages\/core\/lib\/)/.test(relativePath)) return [];
  return [{
    file: relativePath,
    doc: 'docs/PLATFORM_IMPLEMENTATION_TRACKER.md',
    issue: '신규/핵심 파일 추적 확인 필요',
    suggestion: 'TRACKER에 반영 여부 검토',
  }];
}

function checkAll(changedFiles) {
  const files = Array.isArray(changedFiles) ? changedFiles.filter(Boolean) : [];
  const issues = [];

  files.forEach((file) => {
    if (/config\.ya?ml$/i.test(file)) {
      const teamDir = file.split('/').slice(0, 2).join('/');
      issues.push({
        file,
        doc: `${teamDir}/CLAUDE.md`,
        issue: 'config 변경 감지',
        suggestion: '운영 설정 변경 내용 문서 반영 여부 확인',
      });
    }
    if (fileExists(file)) {
      issues.push(...checkTracker(file));
    }
    issues.push(...checkClaudeFile(file));
    issues.push(...checkCoreFile(file));
  });

  const unique = new Map();
  issues.forEach((item) => {
    const key = `${item.file}::${item.doc}::${item.issue}`;
    if (!unique.has(key)) unique.set(key, item);
  });
  return [...unique.values()];
}

function findUntrackedFiles(changedFiles) {
  const files = Array.isArray(changedFiles) ? changedFiles.filter(Boolean) : [];
  const trackerPath = path.join(ROOT, 'docs/PLATFORM_IMPLEMENTATION_TRACKER.md');
  let trackerText = '';
  try {
    trackerText = fs.readFileSync(trackerPath, 'utf8');
  } catch {
    return [];
  }

  return [...new Set(files)]
    .filter((file) => /^(bots\/|packages\/core\/lib\/)/.test(file))
    .filter((file) => fileExists(file))
    .filter((file) => !trackerText.includes(file))
    .sort();
}

module.exports = { checkAll, findUntrackedFiles };
