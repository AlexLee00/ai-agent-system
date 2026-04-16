#!/usr/bin/env node
'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const { publishFacebookPost } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/facebook-publisher.ts'));

function parseArgs(argv = []) {
  const args = {
    dryRun: false,
    json: false,
    message: '',
    link: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--dry-run') args.dryRun = true;
    else if (token === '--json') args.json = true;
    else if (token === '--message') args.message = argv[++i] || '';
    else if (token === '--link') args.link = argv[++i] || '';
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const message = String(args.message || '').trim() || '블로그 신규 포스팅 공유 테스트입니다.';
  const result = await publishFacebookPost({
    message,
    link: String(args.link || '').trim(),
    dryRun: args.dryRun,
  });

  if (args.json) {
    console.log(JSON.stringify({
      message,
      link: args.link || '',
      ...result,
    }, null, 2));
    return;
  }

  console.log(`[facebook] dryRun=${result.dryRun ? 'yes' : 'no'} pageId=${result.pageId || 'n/a'} source=${result.credentialSource || 'unknown'}`);
  console.log(`[facebook] message=${message}`);
  if (args.link) console.log(`[facebook] link=${args.link}`);
  if (result.dryRun) {
    console.log(`[facebook] token request=${result.pageTokenRequest.url}`);
    console.log(`[facebook] publish request=${result.publishRequest.url}`);
    return;
  }
  console.log(`[facebook] postId=${result.postId || 'n/a'}`);
}

main().catch((error) => {
  console.error('[facebook] 게시 실패:', error?.message || error);
  process.exit(1);
});
