'use strict';

/**
 * packages/core/lib/mode-guard.js — OPS/DEV 격리 가드
 *
 * MODE=dev에서 OPS 데이터 접근 시도 시 차단
 * MODE=ops에서 실험적 코드 실행 시 차단
 *
 * 사용법:
 *   const { ensureOps, isOps, isDev } = require('../../../packages/core/lib/mode-guard');
 *
 *   // OPS 전용 작업 진입 시
 *   ensureOps('실투자 주문 실행');
 *
 *   // 조건 분기
 *   if (isOps()) { ... } else { ... }
 *
 * 환경변수 설정:
 *   MODE=ops node bots/investment/markets/crypto.js
 *   MODE=dev node bots/investment/markets/crypto.js  (기본값)
 */

const MODE = (process.env.MODE || 'dev').toLowerCase().trim();

// 유효 MODE 값
const VALID_MODES = ['dev', 'ops'];
if (!VALID_MODES.includes(MODE)) {
  console.warn(`[MODE GUARD] ⚠️ 알 수 없는 MODE 값: "${MODE}" — dev로 처리`);
}

/**
 * OPS 모드 전용 진입 보호
 * MODE=dev에서 호출 시 오류 발생
 *
 * @param {string} operation  - 작업 설명 (오류 메시지에 포함)
 * @throws {Error}
 */
function ensureOps(operation) {
  if (MODE !== 'ops') {
    throw new Error(
      `[MODE GUARD] "${operation}"은 MODE=ops에서만 실행 가능. ` +
      `현재: MODE=${MODE}. 실투자 전환은 마스터 승인 후 MODE=ops로 기동하세요.`
    );
  }
}

/**
 * DEV 모드 전용 진입 보호
 * MODE=ops에서 호출 시 오류 발생 (실험 코드가 OPS에서 실행되는 것 방지)
 *
 * @param {string} operation  - 작업 설명
 * @throws {Error}
 */
function ensureDev(operation) {
  if (MODE !== 'dev') {
    throw new Error(
      `[MODE GUARD] "${operation}"은 MODE=dev에서만 실행 가능. ` +
      `현재: MODE=${MODE}. 실험적 코드가 OPS 환경에서 실행되는 것을 차단합니다.`
    );
  }
}

/**
 * OPS 모드 여부
 * @returns {boolean}
 */
function isOps() {
  return MODE === 'ops';
}

/**
 * DEV 모드 여부
 * @returns {boolean}
 */
function isDev() {
  return MODE === 'dev';
}

/**
 * 현재 MODE 반환
 * @returns {string} 'ops' | 'dev'
 */
function getMode() {
  return MODE;
}

/**
 * 안전한 OPS 실행 래퍼
 * OPS에서만 fn을 실행하고, DEV에서는 dry-run 로그만 출력
 *
 * @param {string}   operation  - 작업 설명
 * @param {function} fn         - OPS에서 실행할 함수 (async 지원)
 * @param {function} [dryRunFn] - DEV에서 대신 실행할 함수 (선택)
 * @returns {Promise<any>}
 */
async function runIfOps(operation, fn, dryRunFn = null) {
  if (MODE === 'ops') {
    return await fn();
  }
  if (dryRunFn) {
    return await dryRunFn();
  }
  console.log(`[MODE GUARD] DEV 모드 — "${operation}" dry-run 스킵`);
  return null;
}

module.exports = {
  MODE,
  ensureOps,
  ensureDev,
  isOps,
  isDev,
  getMode,
  runIfOps,
};
