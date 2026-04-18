// @ts-nocheck
'use strict';

/**
 * scripts/codex-notifier-runner.ts — 코덱스 알림 브로드캐스터 실행 스크립트
 *
 * Kill Switch: CLAUDE_CODEX_NOTIFIER_ENABLED=true (기본 false)
 * Shadow 모드: CLAUDE_NOTIFIER_SHADOW=false 시 실제 발송 (기본 Shadow ON)
 *
 * 실행:
 *   node bots/claude/scripts/codex-notifier-runner.ts
 *   CLAUDE_CODEX_NOTIFIER_ENABLED=true node ...
 */

const path = require('path');
process.env.PG_DIRECT = process.env.PG_DIRECT || 'true';

const { mainLoop } = require('../lib/codex-plan-notifier');

async function main() {
  const enabled    = process.env.CLAUDE_CODEX_NOTIFIER_ENABLED === 'true';
  const shadowMode = process.env.CLAUDE_NOTIFIER_SHADOW !== 'false';

  if (!enabled) {
    console.log('[codex-notifier] Kill Switch OFF — CLAUDE_CODEX_NOTIFIER_ENABLED=true 설정 필요');
    console.log('[codex-notifier] 대기 모드 (30초 후 종료)');
    await new Promise(r => setTimeout(r, 30000));
    process.exit(0);
  }

  console.log(`[codex-notifier] 시작`);
  console.log(`[codex-notifier] Shadow 모드: ${shadowMode ? 'ON (로그만)' : 'OFF (실제 발송)'}`);
  console.log(`[codex-notifier] 감시 주기: 5분`);
  console.log(`[codex-notifier] Rate Limit: 20건/시간`);

  try {
    await mainLoop();
  } catch (e) {
    console.error('[codex-notifier] Fatal:', e.message);
    process.exit(1);
  }
}

main();
