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

function readLastN(filePath, n = 200) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.split('\n').filter(Boolean).slice(-n);
  } catch { return []; }
}

function analyzeLog(filePath, label) {
  const result = { label, status: 'ok', detail: '' };

  if (!fs.existsSync(filePath)) {
    result.status = 'ok';
    result.detail = '로그 없음 (정상 대기)';
    return result;
  }

  // 파일 크기
  const sizeMB = fs.statSync(filePath).size / 1024 / 1024;
  if (sizeMB > cfg.THRESHOLDS.logMaxMB) {
    return { label, status: 'warn', detail: `로그 크기 ${sizeMB.toFixed(1)}MB (>${cfg.THRESHOLDS.logMaxMB}MB) — 로테이션 필요` };
  }

  const lines      = readLastN(filePath, 100);
  const total      = lines.length;
  const errCount   = lines.filter(l => ERROR_PATTERNS.some(p => p.test(l))).length;
  const warnCount  = lines.filter(l => WARN_PATTERNS.some(p => p.test(l))).length;
  const errorRate  = total > 0 ? (errCount / total * 100) : 0;

  // 반복 오류 패턴 (최근 10줄 중 동일 패턴 3회 이상)
  const recent = readLastN(filePath, 10);
  const errLines = recent.filter(l => ERROR_PATTERNS.some(p => p.test(l)));
  const repeating = errLines.length >= 3;

  if (errCount === 0 && warnCount === 0) {
    result.detail = `정상 (최근 ${total}줄)`;
  } else if (errorRate >= cfg.THRESHOLDS.errorRateCrit || repeating) {
    result.status = 'error';
    result.detail = `오류율 ${errorRate.toFixed(0)}% (${errCount}/${total}) ${repeating ? '— 반복 오류 감지' : ''}`;
  } else if (errorRate >= cfg.THRESHOLDS.errorRateWarn) {
    result.status = 'warn';
    result.detail = `오류율 ${errorRate.toFixed(0)}% (${errCount}/${total}), 경고 ${warnCount}건`;
  } else {
    result.detail = `오류 ${errCount}건 경고 ${warnCount}건 / 최근 ${total}줄`;
  }

  return result;
}

async function run() {
  const items = [];

  // 봇별 로그 분석
  items.push(analyzeLog(cfg.LOGS.naver,  '스카팀 (naver-monitor)'));
  items.push(analyzeLog(cfg.LOGS.invest, '루나팀 (invest pipeline)'));
  items.push(analyzeLog(cfg.LOGS.bridge, '루나팀 (upbit bridge)'));

  // OpenClaw 로그 (디렉토리 내 최신 파일)
  if (fs.existsSync(cfg.LOGS.openclaw)) {
    try {
      const files = fs.readdirSync(cfg.LOGS.openclaw)
        .filter(f => f.endsWith('.log'))
        .sort().reverse();
      if (files.length > 0) {
        items.push(analyzeLog(path.join(cfg.LOGS.openclaw, files[0]), 'OpenClaw 게이트웨이'));
      }
    } catch { /* openclaw 로그 없음 */ }
  }

  // 덱스터 자신의 이전 로그
  if (fs.existsSync(cfg.LOGS.dexter)) {
    const sizeMB = fs.statSync(cfg.LOGS.dexter).size / 1024 / 1024;
    items.push({
      label:  '덱스터 로그',
      status: sizeMB > 10 ? 'warn' : 'ok',
      detail: `${sizeMB.toFixed(2)}MB`,
    });
  }

  const hasError = items.some(i => i.status === 'error');
  const hasWarn  = items.some(i => i.status === 'warn');

  return {
    name:   '오류 로그',
    status: hasError ? 'error' : hasWarn ? 'warn' : 'ok',
    items,
  };
}

module.exports = { run };
