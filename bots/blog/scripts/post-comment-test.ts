#!/usr/bin/env node
'use strict';

const { postComment } = require('../lib/commenter.ts');

function parseArgs(argv = process.argv.slice(2)) {
  const get = (name) => argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  return {
    url: get('url') || 'https://blog.naver.com/cafe_library/224195637522',
    text: get('text') || '일반 댓글 자동화 등록 테스트입니다. 답글이 아니라 신규 댓글 등록 경로를 확인하고 있어요.',
    testMode: argv.includes('--test-mode'),
    json: argv.includes('--json'),
  };
}

async function main() {
  const args = parseArgs();
  const result = await postComment(args.url, args.text, { testMode: args.testMode });

  if (args.json) {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return;
  }

  console.log(`✅ 일반 댓글 등록 완료: ${args.url}`);
  console.log(`- comment: ${args.text}`);
}

main().catch((error) => {
  console.error(`❌ ${error?.stack || error?.message || String(error)}`);
  process.exit(1);
});
