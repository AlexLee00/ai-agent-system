// @ts-nocheck
'use strict';

const { execSync } = require('child_process');
const env = require('../../../../packages/core/lib/env');

const SUSPICIOUS_PATTERNS = [
  { pattern: /\.pyc$/i, reason: 'Python 캐시' },
  { pattern: /\.log$/i, reason: '로그 파일' },
  { pattern: /\.jsonl$/i, reason: 'JSONL 로그' },
  { pattern: /\/uploads\//i, reason: '사용자 업로드' },
  { pattern: /__pycache__/i, reason: 'Python 캐시 디렉토리' },
  { pattern: /\.traineddata$/i, reason: 'OCR/ML 데이터' },
  { pattern: /\.db$/i, reason: '데이터베이스 파일' },
  { pattern: /node_modules/i, reason: 'node_modules' },
  { pattern: /\.env\.local$/i, reason: '로컬 환경 파일' },
  { pattern: /\.checksums/i, reason: '런타임 체크섬' },
];

function safeExec(command) {
  try {
    return execSync(command, {
      cwd: env.PROJECT_ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
  } catch (error) {
    console.warn(`[steward/git-hygiene] 명령 실패: ${error.message}`);
    return '';
  }
}

function scanTracked() {
  const output = safeExec('git ls-files');
  if (!output) return [];

  const files = output.split('\n').filter(Boolean);
  const suspicious = [];
  for (const file of files) {
    for (const { pattern, reason } of SUSPICIOUS_PATTERNS) {
      if (pattern.test(file)) {
        suspicious.push({ file, reason });
        break;
      }
    }
  }
  return suspicious;
}

function scanUntracked(limit = 50) {
  const output = safeExec(`git ls-files --others --exclude-standard | head -${limit}`);
  return output ? output.split('\n').filter(Boolean) : [];
}

module.exports = {
  SUSPICIOUS_PATTERNS,
  scanTracked,
  scanUntracked,
};
