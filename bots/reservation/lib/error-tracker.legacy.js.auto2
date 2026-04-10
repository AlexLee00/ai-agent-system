/**
 * lib/error-tracker.js — 연속 오류 카운터 (SKA-P05)
 *
 * 루나팀 패턴 적용: 연속 N회 오류 감지 → 에스컬레이션 텔레그램 알림
 *
 * 모드:
 *   in-memory (기본) — naver-monitor 등 장시간 실행 프로세스
 *   persist=true      — kiosk-monitor 등 launchd 1회성 스크립트 (파일로 카운터 유지)
 *
 * 사용법:
 *   const tracker = createErrorTracker({ label: 'naver-monitor', threshold: 3 });
 *   await tracker.fail(error);  // 실패 기록 (임계값 도달 시 자동 알림)
 *   tracker.success();          // 성공 → 카운터 초기화
 *   tracker.getCount();         // 현재 연속 실패 횟수
 *
 *   // launchd 1회성 스크립트용 (파일 영속)
 *   const tracker = createErrorTracker({ label: 'kiosk-monitor', threshold: 3, persist: true });
 */

const fs   = require('fs');
const path = require('path');
const { publishToMainBot } = require('./mainbot-client');
const { log } = require('./utils');

const DEFAULT_THRESHOLD   = 3;   // 연속 3회 실패 시 첫 알림
const ESCALATION_INTERVAL = 10;  // 임계값 초과 후 N회마다 추가 알림
const PERSIST_DIR         = '/tmp';

/**
 * 연속 오류 카운터 생성
 * @param {Object} opts
 * @param {string}  opts.label              — 식별자 (예: 'naver-monitor')
 * @param {number} [opts.threshold=3]       — 첫 에스컬레이션 임계값
 * @param {boolean} [opts.persist=false]    — true: /tmp/ska-{label}-errors.json 파일로 카운터 유지
 * @returns {{ fail, success, getCount, reset }}
 */
function createErrorTracker({ label = 'unknown', threshold = DEFAULT_THRESHOLD, persist = false } = {}) {
  const persistPath = path.join(PERSIST_DIR, `ska-${label}-errors.json`);

  // 초기 카운터 로드
  let count = 0;
  if (persist) {
    try {
      const saved = JSON.parse(fs.readFileSync(persistPath, 'utf-8'));
      count = saved.count || 0;
      if (count > 0) log(`[${label}] 이전 연속 오류 카운터 복원: ${count}회`);
    } catch { /* 파일 없음 = 첫 실행 */ }
  }

  function _saveCount() {
    if (!persist) return;
    try {
      fs.writeFileSync(persistPath, JSON.stringify({ count, updatedAt: new Date().toISOString() }));
    } catch (e) { log(`⚠️ [${label}] 오류 카운터 저장 실패: ${e.message}`); }
  }

  function _clearSaved() {
    if (!persist) return;
    try { fs.unlinkSync(persistPath); } catch { /* 없으면 무시 */ }
  }

  /**
   * 실패 기록. 임계값 도달 시 텔레그램 알림 발송.
   * @param {Error|string} error
   */
  function fail(error) {
    count++;
    const msg = (error instanceof Error ? error.message : String(error)) || '알 수 없는 오류';
    log(`⚠️ [${label}] 연속 오류 ${count}회: ${msg}`);
    _saveCount();

    const isFirstAlert = count === threshold;
    const isEscalation = count > threshold && (count - threshold) % ESCALATION_INTERVAL === 0;

    if (isFirstAlert || isEscalation) {
      const lines = [
        `🚨 연속 오류 감지 — ${label}`,
        `연속 실패: ${count}회`,
        `최근 오류: ${msg.slice(0, 150)}`,
        `시각: ${new Date().toLocaleTimeString('ko-KR')}`,
      ];
      if (count > threshold) lines.push(`(${count - threshold}회 추가 지속 — 수동 확인 권장)`);
      publishToMainBot({ from_bot: 'ska', event_type: 'alert', alert_level: 3, message: lines.join('\n') });
    }
  }

  /**
   * 성공 기록. 연속 오류 카운터 초기화.
   */
  function success() {
    if (count > 0) {
      log(`✅ [${label}] 오류 복구 (연속 ${count}회 후 성공 → 카운터 초기화)`);
      count = 0;
      _clearSaved();
    }
  }

  /** 현재 연속 실패 횟수 반환 */
  function getCount() { return count; }

  /** 카운터 강제 초기화 */
  function reset() { count = 0; _clearSaved(); }

  return { fail, success, getCount, reset };
}

module.exports = { createErrorTracker };
