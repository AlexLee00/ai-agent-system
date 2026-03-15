'use strict';

/**
 * src/filter.js — 알람 필터링 엔진
 *
 * mainbot_queue에 들어온 항목을 처리 방식 결정:
 *   - 무음 → skip
 *   - 야간 + MEDIUM 이하 → morning_queue 보류
 *   - HIGH 이상 → 즉시 발송
 *   - CRITICAL → 즉시 발송 + confirm 요청
 *   - 단기 중복 → 배치 집약
 */

const { isAlertMuted, isEventMuted } = require('../lib/mute-manager');
const { shouldDefer, deferToMorning } = require('../lib/night-handler');
const { formatSingle, formatBatch }   = require('../lib/batch-formatter');
const { getEventHeadline } = require('../../../packages/core/lib/reporting-hub');

const DEDUP_WINDOW_MS = 60_000; // 1분 내 같은 봇+이벤트타입 중복 배치

// 최근 처리 캐시 (메모리, 프로세스 재시작 시 초기화)
const _recent = new Map(); // `${fromBot}:${eventType}` → { items, timer, resolve }

function buildBatchKey(item) {
  const headline = getEventHeadline(item)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return [
    item.from_bot || 'unknown',
    item.team || 'general',
    item.event_type || 'report',
    headline || 'no-headline',
  ].join(':');
}

/**
 * 큐 항목 처리 방식 결정
 * @param {object} item  mainbot_queue 행
 * @param {Function} onSend  (message: string) => void  실제 발송 콜백
 * @returns {'sent'|'muted'|'deferred'|'batched'}
 */
async function processItem(item, onSend) {
  // 1. 무음 체크 (봇/팀 단위)
  if (await isAlertMuted(item.from_bot, item.team)) {
    return 'muted';
  }

  // 1-b. 이벤트 타입 무음 체크 ("이 알람 안 해도 돼" 등으로 설정)
  if (await isEventMuted(item.from_bot, item.event_type)) {
    return 'muted';
  }

  // 2. 야간 보류 체크
  if (shouldDefer(item.alert_level)) {
    await deferToMorning(item.id, getEventHeadline(item).slice(0, 60), [item.from_bot]);
    return 'deferred';
  }

  // 3. 중복 배치 체크 (MEDIUM 이하만 배치, HIGH/CRITICAL은 즉시)
  if (item.alert_level <= 2) {
    const key = buildBatchKey(item);
    if (_recent.has(key)) {
      const batch = _recent.get(key);
      batch.items.push(item);
      return 'batched';
    }

    // 새 배치 윈도우 시작
    const batch = { items: [item] };
    batch.timer = setTimeout(() => {
      _recent.delete(key);
      const msg = formatBatch(item.from_bot, batch.items);
      onSend(msg, batch.items); // 전체 배치 항목 전달 (DB 일괄 업데이트용)
    }, DEDUP_WINDOW_MS);

    _recent.set(key, batch);
    return 'batched';
  }

  // 4. 즉시 발송 (HIGH/CRITICAL)
  const msg = formatSingle(item);
  const ok = await onSend(msg, item);
  return ok ? 'sent' : 'error';
}

/**
 * 배치 타이머 강제 플러시 (종료 시)
 */
function flushAll(onSend) {
  for (const [key, batch] of _recent.entries()) {
    clearTimeout(batch.timer);
    if (batch.items.length > 0) {
      const first = batch.items[0];
      const msg   = formatBatch(first.from_bot, batch.items);
      onSend(msg, batch.items); // 전체 배치 항목 전달
    }
    _recent.delete(key);
  }
}

module.exports = { processItem, flushAll };
