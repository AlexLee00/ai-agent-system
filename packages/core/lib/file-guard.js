'use strict';

/**
 * packages/core/lib/file-guard.js — 소스코드 수정 방지 가드
 *
 * 봇이 fs.writeFileSync 등으로 소스코드를 수정하는 것을 방지.
 * 오직 마스터(Alex)와 Claude Code만 소스코드 수정 권한을 가진다.
 *
 * 사용법:
 *   const { safeWriteFile, canWrite } = require('../../../packages/core/lib/file-guard');
 *   safeWriteFile('/path/to/file.json', content, 'ska');
 */

const fs   = require('fs');
const path = require('path');

// ─── 수정 금지 확장자 ────────────────────────────────────────────
const PROTECTED_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs',
  '.ts', '.tsx', '.jsx',
  '.py',
  '.sh', '.bash', '.zsh',
]);

// ─── 명시적 금지 파일명 ──────────────────────────────────────────
const BLOCKED_FILENAMES = new Set([
  'package.json',
  'package-lock.json',
  'CLAUDE.md',
  '.env',
  'config.yaml',
  'config.yml',
  'secrets.json',
]);

// ─── 덱스터 전용 허용 파일 패턴 ─────────────────────────────────
// callerBot === 'dexter' 일 때만 적용 (BLOCKED_FILENAMES 검사 전 통과)
const DEXTER_ALLOWED_PATTERNS = [
  /\.checksums\.json$/,   // 체크섬 갱신 (--update-checksums / fixChecksums)
  /dexter-state\.json$/,  // 자기진단 상태
  /dexter-mode\.json$/,   // 운영 모드 상태
  /\.lock$/,              // stale lock 파일 (삭제 대상)
];

// ─── 쓰기 허용 패턴 (데이터·산출물 파일) ────────────────────────
// 이 패턴에 매칭되면 확장자 검사 전에 허용
const ALLOWED_WRITE_PATTERNS = [
  /\.log$/i,
  /\.html$/i,
  /\.txt$/i,
  /\.csv$/i,
  /\.png$/i, /\.jpg$/i, /\.jpeg$/i, /\.webp$/i, /\.gif$/i,
  /\.pdf$/i,
  // 상태·캐시 JSON (경로 기준)
  /[/\\]\.openclaw[/\\]/,
  /[/\\]workspace[/\\]/,
  /[/\\]tmp[/\\]/,
  /[/\\]output[/\\]/,
  /[/\\]cache[/\\]/,
  /[/\\]logs?[/\\]/,
  // 덱스터 산출물
  /dexter-fixes\.json$/,
  /dexter-issues\.json$/,
  // 스크리닝 상태
  /screening-monitor-state\.json$/,
  /prescreened\.json$/,
  // 블로그 산출물
  /insta-meta\.json$/,
  // naver-bookings
  /naver-bookings.*\.json$/,
  // health-check 상태
  /health-check-state\.json$/,
];

// ─── 권한 체크 ───────────────────────────────────────────────────

/**
 * 파일 쓰기 허용 여부 확인
 * @param {string} filePath
 * @param {string} callerBot - 호출 봇 이름 (로그용)
 * @returns {boolean}
 */
function canWrite(filePath, callerBot = 'unknown') {
  const normalized = filePath.replace(/\\/g, '/');
  const ext        = path.extname(filePath).toLowerCase();
  const basename   = path.basename(filePath);

  // 0. 덱스터 전용 허용 파일 (BLOCKED_FILENAMES 검사 전)
  if (callerBot === 'dexter') {
    for (const pattern of DEXTER_ALLOWED_PATTERNS) {
      if (pattern.test(normalized)) return true;
    }
  }

  // 1. 명시적 금지 파일
  if (BLOCKED_FILENAMES.has(basename)) {
    _warn(callerBot, filePath, `명시적 금지 파일 (${basename})`);
    return false;
  }

  // 2. 허용 패턴 — 확장자 검사 전에 통과
  for (const pattern of ALLOWED_WRITE_PATTERNS) {
    if (pattern.test(normalized)) return true;
  }

  // 3. 보호 확장자 차단
  if (PROTECTED_EXTENSIONS.has(ext)) {
    _warn(callerBot, filePath, `보호 확장자 (${ext})`);
    return false;
  }

  // 4. .json 확장자는 경로 기반 추가 검사
  // 프로젝트 루트의 JSON(package.json 계열)은 이미 BLOCKED_FILENAMES에서 잡힘
  // 나머지는 허용
  return true;
}

function _warn(callerBot, filePath, reason) {
  console.error(`🚨 [file-guard] ${callerBot} → ${filePath} 쓰기 차단 (${reason})`);
}

// ─── 안전 쓰기 래퍼 ─────────────────────────────────────────────

/**
 * fs.writeFileSync 대신 사용하는 안전한 쓰기 함수
 * 차단 시 CRITICAL 텔레그램 알림 발송 후 예외 throw
 *
 * @param {string} filePath
 * @param {string|Buffer} content
 * @param {string} callerBot
 * @param {string} [encoding]
 */
function safeWriteFile(filePath, content, callerBot = 'unknown', encoding = 'utf8') {
  if (!canWrite(filePath, callerBot)) {
    // 텔레그램 CRITICAL 알림 (fire-and-forget)
    try {
      const sender = require('./telegram-sender');
      sender.sendCritical('general',
        `🚨 [보안] 소스코드 수정 시도 차단!\n봇: ${callerBot}\n파일: ${filePath}\n→ 마스터 확인 필요`
      );
    } catch { /* 발송 실패 무시 */ }

    throw new Error(`[file-guard] ${callerBot}의 소스코드 수정 시도 차단: ${filePath}`);
  }

  fs.writeFileSync(filePath, content, encoding);
}

/**
 * safeWriteFile의 비동기 버전 (fs.promises.writeFile 대체)
 */
async function safeWriteFileAsync(filePath, content, callerBot = 'unknown', encoding = 'utf8') {
  if (!canWrite(filePath, callerBot)) {
    try {
      const sender = require('./telegram-sender');
      await sender.sendCritical('general',
        `🚨 [보안] 소스코드 수정 시도 차단!\n봇: ${callerBot}\n파일: ${filePath}\n→ 마스터 확인 필요`
      );
    } catch { /* 무시 */ }

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
