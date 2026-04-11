const env = require('../../../packages/core/lib/env');
import { hasSecret } from './secrets';

export function getMode(): string {
  return env.MODE;
}

export function isOpsMode(): boolean {
  return env.IS_OPS;
}

export function assertOpsReady(): void {
  const errors: string[] = [];
  if (!env.IS_OPS) errors.push('MODE=ops 환경변수 미설정');
  if (!hasSecret('pickko_id')) errors.push('pickko_id 미설정');
  if (!hasSecret('pickko_pw')) errors.push('pickko_pw 미설정');
  if (!hasSecret('naver_id')) errors.push('naver_id 미설정');
  if (!hasSecret('naver_pw')) errors.push('naver_pw 미설정');
  if (!hasSecret('telegram_bot_token')) errors.push('telegram_bot_token 미설정 (OPS는 알림 필수)');
  if (!hasSecret('db_encryption_key')) errors.push('db_encryption_key 미설정');
  if (errors.length > 0) {
    throw new Error([
      '🚨 OPS 모드 진입 거부:',
      ...errors.map((error) => `  ❌ ${error}`),
      '',
      '해결 방법:',
      '  1. secrets.json: pickko_id/pw, naver_id/pw, telegram_bot_token, db_encryption_key 설정',
      '  2. MODE=ops 환경변수 설정',
      '  3. scripts/start-ops.sh 로 실행',
    ].join('\n'));
  }
}

export function printModeBanner(scriptName = ''): void {
  env.printModeBanner(scriptName);
}

export function guardRealAction(action: string): void {
  if (!env.IS_OPS) {
    throw new Error(
      `🚨 실동작 차단: OPS 모드 아닌 상태에서 실제 변경 시도\n` +
      `  action=${action}\n` +
      '  scripts/start-ops.sh 를 통해서만 OPS 실행 가능'
    );
  }
}

export function getModeSuffix(): string {
  return env.modeSuffix();
}
