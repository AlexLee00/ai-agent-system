/**
 * shared/time-mode.js — 시간대 모드 관리 (ESM)
 *
 * 루나팀 사이클에서 시간대에 따라 매매 파라미터 조정.
 *
 * ACTIVE     06:00~22:00 KST — 일반 운영
 * SLOWDOWN   22:00~00:00 KST — 거래량 감소, 포지션 축소
 * NIGHT_AUTO 00:00~06:00 KST — 자동 운영, 최소 포지션
 */

import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const kst = _require('../../../packages/core/lib/kst');

// KST 시간 (0~23) — kst.currentHour() 위임
function getKSTHour() {
  return kst.currentHour();
}

/**
 * 현재 시간 모드
 * @returns {'ACTIVE'|'SLOWDOWN'|'NIGHT_AUTO'}
 */
export function getTimeMode() {
  const h = getKSTHour();
  if (h >= 6 && h < 22)  return 'ACTIVE';
  if (h >= 22)            return 'SLOWDOWN';
  return 'NIGHT_AUTO';   // 0~5시
}

/**
 * 야간 여부 (메인봇 night-handler와 동일 기준)
 */
export function isNightTime() {
  const h = getKSTHour();
  return h >= 22 || h < 8;
}

/**
 * 시간대별 루나팀 매매 파라미터
 * @returns {object}
 */
export function getLunaParams() {
  const mode = getTimeMode();

  const base = {
    mode,
    kstHour: getKSTHour(),
  };

  switch (mode) {
    case 'ACTIVE':
      return {
        ...base,
        maxPositionPct:    0.15,   // 포트폴리오 대비 최대 포지션 15%
        maxOpenPositions:  3,      // 최대 동시 오픈 포지션
        minSignalScore:    0.58,   // 최소 신호 점수 (소폭 완화)
        cycleSec:          1800,   // 30분 사이클
        emergencyTrigger:  true,   // BTC ±3% 긴급 트리거 활성
      };

    case 'SLOWDOWN':
      return {
        ...base,
        maxPositionPct:    0.08,
        maxOpenPositions:  2,
        minSignalScore:    0.72,   // 더 높은 신뢰도 요구
        cycleSec:          3600,   // 60분 사이클
        emergencyTrigger:  true,
      };

    case 'NIGHT_AUTO':
      return {
        ...base,
        maxPositionPct:    0.05,
        maxOpenPositions:  1,
        minSignalScore:    0.80,   // 야간 고신뢰도만
        cycleSec:          3600,
        emergencyTrigger:  false,  // 야간 긴급 트리거 비활성
      };

    default:
      return { ...base, maxPositionPct: 0.05, maxOpenPositions: 1, minSignalScore: 0.8, cycleSec: 3600, emergencyTrigger: false };
  }
}
