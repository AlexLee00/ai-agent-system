// @ts-nocheck
'use strict';

/**
 * checks/logs.js — 오류 로그 분석
 * - 봇별 로그 파일 ❌ 오류 패턴 카운트
 * - 최근 100줄 기준 오류율 계산
 * - 반복 오류 패턴 감지
 * - 로그 파일 크기 점검
 */

const fs   = require('fs');
const path = require('path');
const cfg  = require('../config');

const ERROR_PATTERNS = [/❌/, /ERROR/, /error:/i, /FATAL/, /uncaughtException/, /UnhandledPromiseRejection/];
const WARN_PATTERNS  = [/⚠️/, /WARN/, /warn:/i, /deprecated/i];

function pathExists(target) {
  return typeof target === 'string' && target.length > 0 && fs.existsSync(target);
}

// 로그 품질 특수 패턴
const QUALITY_PATTERNS = [
  { re: /TimeoutError|timeout.*exceeded|Navigation timeout/i, label: 'Playwright 타임아웃', threshold: 5 },
  { re: /rate.?limit|RateLimitError|\bHTTP 429\b|Too Many Requests/i, label: 'Rate Limit', threshold: 3 },
  { re: /ECONNREFUSED|ECONNRESET|ETIMEDOUT/i,                 label: '네트워크 연결 거부', threshold: 5 },
];

function readLastN(filePath, n = 200) {
  if (!pathExists(filePath)) return [];
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.split('\n').filter(Boolean).slice(-n);
  } catch { return []; }
}

// 동일 오류 10회 이상 반복 감지 (최근 200줄 기준)
function detectRepeatedErrors(lines) {
  const freq = {};
  for (const line of lines) {
    if (!ERROR_PATTERNS.some(p => p.test(line))) continue;
    // 타임스탬프·PID 제거 후 정규화 (앞 60자 기준)
    const normalized = line.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^\s]*/g, '').trim().slice(0, 80);
    if (normalized.length < 10) continue;
    freq[normalized] = (freq[normalized] || 0) + 1;
  }
  return Object.entries(freq)
    .filter(([, cnt]) => cnt >= 10)
    .map(([msg, cnt]) => ({ msg: msg.slice(0, 60), cnt }));
}

function analyzeLog(filePath, label) {
  const result = { label, status: 'ok', detail: '' };

  if (!pathExists(filePath)) {
    result.status = 'ok';
    result.detail = '로그 없음 (정상 대기)';
    return result;
  }

  // 파일 크기
  const sizeMB = fs.statSync(filePath).size / 1024 / 1024;
  if (sizeMB > cfg.THRESHOLDS.logMaxMB) {
    return { label, status: 'warn', detail: `로그 크기 ${sizeMB.toFixed(1)}MB (>${cfg.THRESHOLDS.logMaxMB}MB) — 로테이션 필요` };
  }

  const lines      = readLastN(filePath, 200);
  const total      = lines.length;
  const errCount   = lines.filter(l => ERROR_PATTERNS.some(p => p.test(l))).length;
  const warnCount  = lines.filter(l => WARN_PATTERNS.some(p => p.test(l))).length;
  const errorRate  = total > 0 ? (errCount / total * 100) : 0;

  // 동일 오류 10회 이상 반복 감지
  const repeated = detectRepeatedErrors(lines);

  if (errCount === 0 && warnCount === 0) {
    result.detail = `정상 (최근 ${total}줄)`;
  } else if (errorRate >= cfg.THRESHOLDS.errorRateCrit || repeated.length > 0) {
    result.status = 'error';
    const repeatInfo = repeated.length > 0
      ? ` — 반복오류: "${repeated[0].msg}" ${repeated[0].cnt}회`
      : '';
    result.detail = `오류율 ${errorRate.toFixed(0)}% (${errCount}/${total})${repeatInfo}`;
  } else if (errorRate >= cfg.THRESHOLDS.errorRateWarn) {
    result.status = 'warn';
    result.detail = `오류율 ${errorRate.toFixed(0)}% (${errCount}/${total}), 경고 ${warnCount}건`;
  } else {
    result.detail = `오류 ${errCount}건 경고 ${warnCount}건 / 최근 ${total}줄`;
  }

  return result;
}

// 로그 품질 패턴 체크 (Playwright 타임아웃, rate_limit 등)
function checkLogQuality(items) {
  const LOG_FILES = {
    '스카팀':     cfg.LOGS.naver,
    '루나 크립토': cfg.LOGS.crypto,
    '루나 국내':   cfg.LOGS.domestic,
    '루나 해외':   cfg.LOGS.overseas,
  };

  for (const [botLabel, filePath] of Object.entries(LOG_FILES)) {
    if (!pathExists(filePath)) continue;
    const lines = readLastN(filePath, 200);
    for (const { re, label, threshold } of QUALITY_PATTERNS) {
      // JSON 데이터 포함 라인(300자 초과)은 앞 300자만 검사 — 전화번호 등 오탐 방지
      const cnt = lines.filter(l => re.test(l.length > 300 ? l.slice(0, 300) : l)).length;
      if (cnt >= threshold) {
        items.push({
          label:  `${botLabel} — ${label}`,
          status: 'warn',
          detail: `최근 200줄에서 ${cnt}회 감지 (기준: ${threshold}회)`,
        });
      }
    }
  }
}

async function run() {
  const items = [];

  // 봇별 로그 분석
  items.push(analyzeLog(cfg.LOGS.naver,    '스카팀 (naver-monitor)'));
  items.push(analyzeLog(cfg.LOGS.crypto,   '루나팀 (크립토 사이클)'));
  items.push(analyzeLog(cfg.LOGS.domestic, '루나팀 (국내주식 사이클)'));
  items.push(analyzeLog(cfg.LOGS.overseas, '루나팀 (해외주식 사이클)'));

  // 덱스터 자신의 이전 로그
  if (pathExists(cfg.LOGS.dexter)) {
    const sizeMB = fs.statSync(cfg.LOGS.dexter).size / 1024 / 1024;
    items.push({
      label:  '덱스터 로그',
      status: sizeMB > 10 ? 'warn' : 'ok',
      detail: `${sizeMB.toFixed(2)}MB`,
    });
  }

  // 로그 품질 패턴 체크 (Playwright 타임아웃, rate_limit 등)
  checkLogQuality(items);

  const hasError = items.some(i => i.status === 'error');
  const hasWarn  = items.some(i => i.status === 'warn');

  return {
    name:   '오류 로그',
    status: hasError ? 'error' : hasWarn ? 'warn' : 'ok',
    items,
  };
}

module.exports = { run };
