// @ts-nocheck
#!/usr/bin/env node
'use strict';

/**
 * example-cmd.js — CLI 명령 예시
 *
 * 사용법:
 *   node src/example-cmd.js --name=홍길동
 *
 * 출력 (stdout JSON):
 *   { success: true,  message: "..." }
 *   { success: false, message: "오류 내용" }
 */

const { outputResult, fail, successResult, parseArgs, log, delay } = require('@ai-agent/core');

const ARGS = parseArgs(process.argv);

async function main() {
  if (!ARGS.name) {
    fail('필수 인자 누락: --name\n사용법: node example-cmd.js --name=이름');
  }

  log(`실행 중: name=${ARGS.name}`);
  await delay(100);

  successResult(`완료: ${ARGS.name}`, { name: ARGS.name });
}

main().catch(err => fail(err.message));
