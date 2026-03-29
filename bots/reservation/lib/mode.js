'use strict';
/**
 * bots/reservation/lib/mode.js
 *
 * ⚠️  하위 호환용 래퍼 — 실제 구현은 packages/core/lib/env.js
 *
 * 기존 코드:
 *   const { isOpsMode, guardRealAction, getModeSuffix } = require('../lib/mode');
 *   → 계속 동작합니다.
 */
const env = require('../../../packages/core/lib/env');
const { loadSecrets, hasSecret } = require('./secrets');

function getMode()    { return env.MODE; }
function isOpsMode()  { return env.IS_OPS; }

function assertOpsReady() {
  const errors = [];
  if (!env.IS_OPS) errors.push('MODE=ops 환경변수 미설정');
  if (!hasSecret('pickko_id'))           errors.push('pickko_id 미설정');
  if (!hasSecret('pickko_pw'))           errors.push('pickko_pw 미설정');
  if (!hasSecret('naver_id'))            errors.push('naver_id 미설정');
  if (!hasSecret('naver_pw'))            errors.push('naver_pw 미설정');
  if (!hasSecret('telegram_bot_token'))  errors.push('telegram_bot_token 미설정 (OPS는 알림 필수)');
  if (!hasSecret('db_encryption_key'))   errors.push('db_encryption_key 미설정');
  if (errors.length > 0) {
    throw new Error([
      '🚨 OPS 모드 진입 거부:',
      ...errors.map(e => `  ❌ ${e}`),
      '',
      '해결 방법:',
      '  1. secrets.json: pickko_id/pw, naver_id/pw, telegram_bot_token, db_encryption_key 설정',
      '  2. MODE=ops 환경변수 설정',
      '  3. scripts/start-ops.sh 로 실행',
    ].join('\n'));
  }
}

function printModeBanner(scriptName = '') { env.printModeBanner(scriptName); }

function guardRealAction(action) {
  if (!env.IS_OPS) {
    throw new Error(
      `🚨 실동작 차단: OPS 모드 아닌 상태에서 실제 변경 시도\n` +
      `  action=${action}\n` +
      `  scripts/start-ops.sh 를 통해서만 OPS 실행 가능`
    );
  }
}

function getModeSuffix() { return env.modeSuffix(); }

module.exports = {
  getMode,
  isOpsMode,
  assertOpsReady,
  printModeBanner,
  guardRealAction,
  getModeSuffix,
};
