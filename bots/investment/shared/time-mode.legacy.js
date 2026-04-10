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
import { getTimeModeRuntimeConfig } from './runtime-config.js';

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
  const runtime = getTimeModeRuntimeConfig();

  const base = {
    mode,
    kstHour: getKSTHour(),
  };

  switch (mode) {
    case 'ACTIVE':
      return {
        ...base,
        ...runtime.ACTIVE,
      };

    case 'SLOWDOWN':
      return {
        ...base,
        ...runtime.SLOWDOWN,
      };

    case 'NIGHT_AUTO':
      return {
        ...base,
        ...runtime.NIGHT_AUTO,
      };

    default:
      return { ...base, maxPositionPct: 0.05, maxOpenPositions: 1, minSignalScore: 0.8, cycleSec: 3600, emergencyTrigger: false };
  }
}
