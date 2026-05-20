// @ts-nocheck
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
const cfg = require('../config');

const PATTERN_DAYS = Number(cfg.RUNTIME?.patterns?.patternDays || 7);
const NEW_ERROR_HOURS = Number(cfg.RUNTIME?.patterns?.newErrorHours || 8);
const ERROR_THRESH = Number(cfg.RUNTIME?.patterns?.errorThreshold || 5);
const WARN_THRESH = Number(cfg.RUNTIME?.patterns?.warnThreshold || 3);
const CLEANUP_DAYS = Number(cfg.RUNTIME?.patterns?.cleanupDays || 30);

function severityRank(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'critical') return 3;
  if (normalized === 'error') return 2;
  if (normalized === 'warn') return 1;
  return 0;
}

function buildActiveIssueMap(results = []) {
  const active = new Map();
  for (const result of results) {
    for (const item of (result.items || [])) {
      if (!['warn', 'error', 'critical'].includes(item.status)) continue;
      const key = `${result.name}||${String(item.label || '').trim()}`;
      const prev = active.get(key);
      if (!prev || severityRank(item.status) > severityRank(prev)) {
        active.set(key, item.status);
      }
    }
  }
  return active;
}

function classifyPatternStatus(pattern, activeStatus) {
  const normalized = String(activeStatus || '').toLowerCase();
  const currentlyHard = ['error', 'critical'].includes(normalized);
  const repeatedEnough = Number(pattern?.cnt || 0) >= ERROR_THRESH;
  if (currentlyHard) return repeatedEnough ? 'error' : 'warn';
  if (normalized === 'warn') return 'ok';
  return repeatedEnough ? 'error' : 'warn';
}

function shouldExposeHistoricalPattern(activeIssues, key) {
  return activeIssues instanceof Map && activeIssues.size > 0 && activeIssues.has(key);
}

function shouldExposeNewError(activeIssues, key) {
  return shouldExposeHistoricalPattern(activeIssues, key);
}

async function run(results = []) {
  const items = [];
  const activeIssues = buildActiveIssueMap(results);
  let hiddenResolvedPatterns = 0;
  let hiddenResolvedNew = 0;
  let trackedSoftPatterns = 0;

  // 오래된 이력 정리 (30일)
  const deleted = await cleanup(CLEANUP_DAYS);
  if (deleted > 0) {
    items.push({ label: '이력 정리', status: 'ok', detail: `${deleted}건 삭제 (${CLEANUP_DAYS}일 초과)` });
  }

  // 1. 반복 오류 패턴 분석
  const patterns = await getPatterns(PATTERN_DAYS, WARN_THRESH);

  if (patterns.length === 0) {
    items.push({ label: `반복 패턴 (${PATTERN_DAYS}일)`, status: 'ok', detail: '반복 오류 없음' });
  } else if (activeIssues.size === 0) {
    items.push({
      label: '과거 반복 패턴 보류',
      status: 'ok',
      detail: `현재 활성 warn/error가 없어 과거 반복 패턴 ${patterns.length}건은 재승격하지 않음`,
    });
  } else {
    for (const p of patterns) {
      const key = `${p.check_name}||${String(p.label || '').trim()}`;
      const activeStatus = activeIssues.get(key);
      if (!shouldExposeHistoricalPattern(activeIssues, key)) {
        hiddenResolvedPatterns++;
        continue;
      }
      const status = classifyPatternStatus(p, activeStatus);
      if (status === 'ok') {
        trackedSoftPatterns++;
        continue;
      }
      const isError = status === 'error';
      // UTC → KST (+9h) 변환 (last_seen이 이미 Z 포함 가능)
      const lastSeenStr = p.last_seen?.endsWith('Z') ? p.last_seen : (p.last_seen + 'Z');
      const utcMs   = new Date(lastSeenStr).getTime();
      const kstDate = isNaN(utcMs) ? '?' : new Date(utcMs + 9 * 60 * 60 * 1000).toISOString().slice(5, 16).replace('T', ' ');
      items.push({
        label:  `반복 [${p.check_name}] ${p.label}`,
        status,
        detail: `${PATTERN_DAYS}일간 ${p.cnt}회 반복 | 마지막: ${kstDate} KST${isError ? ' → 근본 원인 조사 필요' : ''}`,
      });
    }
  }

  if (trackedSoftPatterns > 0) {
    items.push({
      label: '반복 soft 패턴 추적',
      status: 'ok',
      detail: `현재 WARN으로 이미 노출된 반복 패턴 ${trackedSoftPatterns}건은 추가 경고로 중복 집계하지 않음`,
    });
  }

  // 2. 신규 오류 감지 (24시간 내 첫 등장)
  const newErrors = await getNewErrors(NEW_ERROR_HOURS, PATTERN_DAYS);

  if (newErrors.length > 0) {
    for (const e of newErrors) {
      const key = `${e.check_name}||${String(e.label || '').trim()}`;
      if (!shouldExposeNewError(activeIssues, key)) {
        hiddenResolvedNew++;
        continue;
      }
      // UTC → KST (+9h) 변환 (detected_at이 이미 Z 포함 가능)
      const detectedStr = e.detected_at?.endsWith('Z') ? e.detected_at : (e.detected_at + 'Z');
      const utcMs  = new Date(detectedStr).getTime();
      const kstStr = isNaN(utcMs) ? '?' : new Date(utcMs + 9 * 60 * 60 * 1000).toISOString().slice(11, 16);
      items.push({
        label:  `신규 감지 [${e.check_name}] ${e.label}`,
        status: 'warn',
        detail: `${kstStr} KST 첫 등장 (${e.status}) — 추이 관찰 중`,
      });
    }
  }

  const hiddenTotal = hiddenResolvedPatterns + hiddenResolvedNew;
  if (hiddenTotal > 0) {
    items.push({
      label: '해결된 과거 패턴 숨김',
      status: 'ok',
      detail: `현재 활성 이슈와 무관한 과거 패턴 ${hiddenTotal}건 제외`,
    });
  }

  const hasError = items.some(i => i.status === 'error');
  const hasWarn  = items.some(i => i.status === 'warn');

  return {
    name:   '오류 패턴 분석',
    status: hasError ? 'error' : hasWarn ? 'warn' : 'ok',
    items,
  };
}

module.exports = {
  run,
  buildActiveIssueMap,
  classifyPatternStatus,
  shouldExposeHistoricalPattern,
  shouldExposeNewError,
};
