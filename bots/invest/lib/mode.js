'use strict';

/**
 * lib/mode.js — DEV / OPS 모드 관리
 *
 * DEV 모드 (기본값):
 *   - dry_run=true 강제
 *   - 실제 주문 절대 불가
 *   - INVEST_MODE=dev 또는 미설정
 *
 * OPS 모드 (실거래):
 *   - INVEST_MODE=ops + dry_run=false + API 키 5개 모두 필수
 *   - assertOpsReady() 통과해야만 진입 허용
 *   - 실수 방지를 위한 다중 가드
 *
 * ⚠️  OPS 모드 = 실제 자산 이동. 절대 실수 없도록.
 */

const { loadSecrets, isDryRun } = require('./secrets');

/** 현재 모드 반환 */
function getMode() {
  const envMode = process.env.INVEST_MODE;
  if (envMode === 'ops') return 'ops';
  return 'dev';
}

function isOpsMode() {
  return getMode() === 'ops';
}

/**
 * OPS 모드 진입 전 5단계 검증
 * 하나라도 실패 시 예외 throw → 프로세스 종료
 *
 * @throws {Error} 검증 실패 시
 */
function assertOpsReady() {
  const errors = [];
  const s = loadSecrets();

  // 1. INVEST_MODE=ops 환경변수 확인
  if (process.env.INVEST_MODE !== 'ops') {
    errors.push('INVEST_MODE=ops 환경변수 미설정');
  }

  // 2. dry_run이 명시적으로 false여야 함 (truthy 제외)
  if (s.dry_run !== false) {
    errors.push(`secrets.json dry_run=${JSON.stringify(s.dry_run)} (false여야 함)`);
  }

  // 3. 바이낸스 API 키 확인
  if (!s.binance_api_key || s.binance_api_key.length < 10) {
    errors.push('binance_api_key 미설정');
  }
  if (!s.binance_api_secret || s.binance_api_secret.length < 10) {
    errors.push('binance_api_secret 미설정');
  }

  // 4. 텔레그램 토큰 확인 (OPS는 알림 필수)
  if (!s.telegram_bot_token || s.telegram_bot_token.length < 10) {
    errors.push('telegram_bot_token 미설정 (OPS는 알림 필수)');
  }

  // 5. isDryRun()이 false여야 함 (모든 조건 통합 확인)
  if (isDryRun()) {
    errors.push('isDryRun()=true — 실거래 차단됨');
  }

  if (errors.length > 0) {
    const msg = [
      '🚨 OPS 모드 진입 거부:',
      ...errors.map(e => `  ❌ ${e}`),
      '',
      '해결 방법:',
      '  1. secrets.json: dry_run=false, binance_api_key/secret, telegram_bot_token 설정',
      '  2. INVEST_MODE=ops 환경변수 설정',
      '  3. src/start-invest-ops.sh 로 실행',
    ].join('\n');
    throw new Error(msg);
  }
}

/**
 * 실행 시작 배너 출력
 */
function printModeBanner(scriptName = '') {
  const mode = getMode();
  if (mode === 'ops') {
    console.log('');
    console.log('⚠️  ============================================');
    console.log('⚠️   OPS 모드 — 실제 자산 이동 활성화');
    console.log('⚠️  ============================================');
    if (scriptName) console.log(`⚠️   실행: ${scriptName}`);
    console.log('⚠️  ============================================');
    console.log('');
  } else {
    console.log(`🧪 [DEV 모드] ${scriptName || ''} — 드라이런, 실거래 없음`);
  }
}

/**
 * DEV 환경에서 실수로 OPS 코드 실행 방지
 * (binance-executor 등에서 주문 직전 최종 확인용)
 */
function guardRealOrder(symbol, side, amount) {
  if (isDryRun()) return; // 드라이런이면 통과 (실행 안 됨)

  if (!isOpsMode()) {
    throw new Error(
      `🚨 실거래 차단: INVEST_MODE=ops 아닌 상태에서 실주문 시도\n` +
      `  symbol=${symbol} side=${side} amount=${amount}\n` +
      `  start-invest-ops.sh 를 통해서만 OPS 실행 가능`
    );
  }
}

/**
 * 모드별 파일 경로 접미사 반환
 * OPS:  ''      → /tmp/invest-status.json    (운영 경로 유지)
 * DEV:  '-dev'  → /tmp/invest-status-dev.json
 *
 * DEV 모드 실행이 OPS의 lock/status 파일에 접근하지 않으므로
 * DEV 개발 중에도 OPS가 정상 작동한다.
 */
function getModeSuffix() {
  return isOpsMode() ? '' : '-dev';
}

module.exports = { getMode, isOpsMode, assertOpsReady, printModeBanner, guardRealOrder, getModeSuffix };
