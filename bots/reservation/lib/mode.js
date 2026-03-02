'use strict';

/**
 * lib/mode.js — DEV / OPS 모드 관리 (SKA-P07)
 *
 * 루나팀 lib/mode.js 패턴 적용.
 * 기존 코드베이스 환경변수 MODE=ops/dev 와 호환.
 *
 * DEV 모드 (기본값):
 *   - MODE 미설정 또는 MODE=dev
 *   - 예약 시스템 실제 접근 없음, 분리된 lock/status/profile 사용
 *   - 로컬 개발 및 E2E 테스트 전용. OPS가 동시에 정상 작동 가능.
 *
 * OPS 모드 (실서비스):
 *   - MODE=ops (start-ops.sh 가 설정)
 *   - 네이버 스마트플레이스·픽코 실계정 접근
 *   - assertOpsReady() 통과해야만 진입 허용
 *
 * 사용법:
 *   const { isOpsMode, printModeBanner } = require('../lib/mode');
 *   printModeBanner('naver-monitor');
 *   if (!isOpsMode()) log('DEV 모드: 실제 변경 없음');
 */

const { loadSecrets, hasSecret } = require('./secrets');

/** 현재 모드 반환 ('ops' | 'dev') */
function getMode() {
  return process.env.MODE === 'ops' ? 'ops' : 'dev';
}

/** OPS 모드 여부 */
function isOpsMode() {
  return getMode() === 'ops';
}

/**
 * OPS 모드 진입 전 검증
 * 하나라도 실패 시 에러 throw → 프로세스 종료
 *
 * @throws {Error} 검증 실패 시
 */
function assertOpsReady() {
  const errors = [];
  const s = loadSecrets();

  // 1. MODE=ops 환경변수 확인
  if (process.env.MODE !== 'ops') {
    errors.push('MODE=ops 환경변수 미설정');
  }

  // 2. 픽코 자격증명 확인
  if (!hasSecret('pickko_id')) errors.push('pickko_id 미설정');
  if (!hasSecret('pickko_pw')) errors.push('pickko_pw 미설정');

  // 3. 네이버 자격증명 확인
  if (!hasSecret('naver_id')) errors.push('naver_id 미설정');
  if (!hasSecret('naver_pw')) errors.push('naver_pw 미설정');

  // 4. 텔레그램 토큰 확인 (OPS는 알림 필수)
  if (!hasSecret('telegram_bot_token')) {
    errors.push('telegram_bot_token 미설정 (OPS는 알림 필수)');
  }

  // 5. DB 암호화 키 확인
  if (!hasSecret('db_encryption_key')) errors.push('db_encryption_key 미설정');

  if (errors.length > 0) {
    const msg = [
      '🚨 OPS 모드 진입 거부:',
      ...errors.map(e => `  ❌ ${e}`),
      '',
      '해결 방법:',
      '  1. secrets.json: pickko_id/pw, naver_id/pw, telegram_bot_token, db_encryption_key 설정',
      '  2. MODE=ops 환경변수 설정',
      '  3. scripts/start-ops.sh 로 실행',
    ].join('\n');
    throw new Error(msg);
  }
}

/**
 * 실행 시작 배너 출력
 * @param {string} scriptName — 스크립트 이름 (예: 'naver-monitor')
 */
function printModeBanner(scriptName = '') {
  const mode = getMode();
  if (mode === 'ops') {
    console.log('');
    console.log('🟢 ============================================');
    console.log('🟢   OPS 모드 — 실서비스 (예약 시스템 연결)');
    console.log('🟢 ============================================');
    if (scriptName) console.log(`🟢   실행: ${scriptName}`);
    console.log('🟢 ============================================');
    console.log('');
  } else {
    const tag = scriptName ? ` ${scriptName}` : '';
    console.log(`🧪 [DEV 모드]${tag} — 실계정 변경 없음`);
  }
}

/**
 * DEV 환경에서 실수로 실제 예약 시스템을 변경하려 할 때 차단
 * @param {string} action — 수행하려는 액션 (예: '픽코 예약 취소')
 */
function guardRealAction(action) {
  if (!isOpsMode()) {
    throw new Error(
      `🚨 실동작 차단: OPS 모드 아닌 상태에서 실제 변경 시도\n` +
      `  action=${action}\n` +
      `  scripts/start-ops.sh 를 통해서만 OPS 실행 가능`
    );
  }
}

/**
 * 모드별 파일 접미사
 * OPS: ''   → naver-monitor.lock, /tmp/ska-status.json 등 (기존 경로 유지)
 * DEV: '-dev' → naver-monitor-dev.lock, /tmp/ska-status-dev.json 등
 *
 * DEV 모드로 실행해도 OPS 프로세스의 lock/status 파일에 전혀 접근하지 않으므로
 * OPS가 계속 정상 작동한다.
 */
function getModeSuffix() {
  return isOpsMode() ? '' : '-dev';
}

module.exports = { getMode, isOpsMode, assertOpsReady, printModeBanner, guardRealAction, getModeSuffix };
