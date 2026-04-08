'use strict';

const fs = require('fs');
const path = require('path');
const { postAlarm } = require('./openclaw-client');

const PROTECTED_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs',
  '.ts', '.tsx', '.jsx',
  '.py',
  '.sh', '.bash', '.zsh',
]);

const BLOCKED_FILENAMES = new Set([
  'package.json',
  'package-lock.json',
  'CLAUDE.md',
  '.env',
  'config.yaml',
  'config.yml',
  'secrets.json',
]);

const DEXTER_ALLOWED_PATTERNS = [
  /\.checksums\.json$/,
  /dexter-state\.json$/,
  /dexter-mode\.json$/,
  /\.lock$/,
];

const ALLOWED_WRITE_PATTERNS = [
  /\.log$/i,
  /\.html$/i,
  /\.txt$/i,
  /\.csv$/i,
  /\.png$/i, /\.jpg$/i, /\.jpeg$/i, /\.webp$/i, /\.gif$/i,
  /\.pdf$/i,
  /[/\\]\.openclaw[/\\]/,
  /[/\\]workspace[/\\]/,
  /[/\\]tmp[/\\]/,
  /[/\\]output[/\\]/,
  /[/\\]cache[/\\]/,
  /[/\\]logs?[/\\]/,
  /dexter-fixes\.json$/,
  /dexter-issues\.json$/,
  /screening-monitor-state\.json$/,
  /prescreened\.json$/,
  /insta-meta\.json$/,
  /naver-bookings.*\.json$/,
  /health-check-state\.json$/,
];

function canWrite(filePath, callerBot = 'unknown') {
  const normalized = filePath.replace(/\\/g, '/');
  const ext = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath);

  if (callerBot === 'dexter') {
    for (const pattern of DEXTER_ALLOWED_PATTERNS) {
      if (pattern.test(normalized)) return true;
    }
  }

  if (BLOCKED_FILENAMES.has(basename)) {
    _warn(callerBot, filePath, `명시적 금지 파일 (${basename})`);
    return false;
  }

  for (const pattern of ALLOWED_WRITE_PATTERNS) {
    if (pattern.test(normalized)) return true;
  }

  if (PROTECTED_EXTENSIONS.has(ext)) {
    _warn(callerBot, filePath, `보호 확장자 (${ext})`);
    return false;
  }

  return true;
}

function _warn(callerBot, filePath, reason) {
  console.error(`🚨 [file-guard] ${callerBot} → ${filePath} 쓰기 차단 (${reason})`);
}

function safeWriteFile(filePath, content, callerBot = 'unknown', encoding = 'utf8') {
  if (!canWrite(filePath, callerBot)) {
    postAlarm({
      message: `🚨 [보안] 소스코드 수정 시도 차단!\n봇: ${callerBot}\n파일: ${filePath}\n→ 마스터 확인 필요`,
      team: 'general',
      alertLevel: 4,
      fromBot: 'file-guard',
    }).catch((error) => {
      console.error(`[file-guard] 보안 알람 발송 실패: ${error.message}`);
    });

    throw new Error(`[file-guard] ${callerBot}의 소스코드 수정 시도 차단: ${filePath}`);
  }

  fs.writeFileSync(filePath, content, encoding);
}

async function safeWriteFileAsync(filePath, content, callerBot = 'unknown', encoding = 'utf8') {
  if (!canWrite(filePath, callerBot)) {
    try {
      await postAlarm({
        message: `🚨 [보안] 소스코드 수정 시도 차단!\n봇: ${callerBot}\n파일: ${filePath}\n→ 마스터 확인 필요`,
        team: 'general',
        alertLevel: 4,
        fromBot: 'file-guard',
      });
    } catch {}

    throw new Error(`[file-guard] ${callerBot}의 소스코드 수정 시도 차단: ${filePath}`);
  }

  await fs.promises.writeFile(filePath, content, encoding);
}

module.exports = {
  canWrite,
  safeWriteFile,
  safeWriteFileAsync,
  PROTECTED_EXTENSIONS,
  BLOCKED_FILENAMES,
  ALLOWED_WRITE_PATTERNS,
  DEXTER_ALLOWED_PATTERNS,
};
