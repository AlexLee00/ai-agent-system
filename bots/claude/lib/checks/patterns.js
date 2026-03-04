'use strict';

/**
 * checks/patterns.js — 반복 오류 패턴 분석
 *
 * dexter_error_log 이력을 분석해 반복 오류·신규 오류를 감지.
 *
 * 임계값:
 *   - 7일 내 5회 이상  → error  (근본 원인 조사 필요)
 *   - 7일 내 3회 이상  → warn   (반복 경향 주의)
 *   - 24시간 내 첫 등장 → info  (신규 감지, 추이 관찰)
 */

const { getPatterns, getNewErrors, cleanup } = require('../error-history');

const PATTERN_DAYS  = 7;
const ERROR_THRESH  = 5;  // 5회 이상 → error
const WARN_THRESH   = 3;  // 3회 이상 → warn

async function run() {
  const items = [];

  // 오래된 이력 정리 (30일)
  const deleted = cleanup(30);
  if (deleted > 0) {
    items.push({ label: '이력 정리', status: 'ok', detail: `${deleted}건 삭제 (30일 초과)` });
  }

  // 1. 반복 오류 패턴 분석
  const patterns = getPatterns(PATTERN_DAYS, WARN_THRESH);

  if (patterns.length === 0) {
    items.push({ label: `반복 패턴 (${PATTERN_DAYS}일)`, status: 'ok', detail: '반복 오류 없음' });
  } else {
    for (const p of patterns) {
      const isError  = p.cnt >= ERROR_THRESH;
      const status   = isError ? 'error' : 'warn';
      const lastDate = p.last_seen?.slice(5, 16) || '-';  // MM-DD HH:MM
      items.push({
        label:  `반복 [${p.check_name}] ${p.label}`,
        status,
        detail: `${PATTERN_DAYS}일간 ${p.cnt}회 반복 | 마지막: ${lastDate}${isError ? ' → 근본 원인 조사 필요' : ''}`,
      });
    }
  }

  // 2. 신규 오류 감지 (24시간 내 첫 등장)
  const newErrors = getNewErrors(24, PATTERN_DAYS);

  if (newErrors.length > 0) {
    for (const e of newErrors) {
      const time = e.detected_at?.slice(11, 16) || '-';  // HH:MM
      items.push({
        label:  `신규 감지 [${e.check_name}] ${e.label}`,
        status: 'warn',
        detail: `${time} 첫 등장 (${e.status}) — 추이 관찰 중`,
      });
    }
  }

  const hasError = items.some(i => i.status === 'error');
  const hasWarn  = items.some(i => i.status === 'warn');

  return {
    name:   '오류 패턴 분석',
    status: hasError ? 'error' : hasWarn ? 'warn' : 'ok',
    items,
  };
}

module.exports = { run };
