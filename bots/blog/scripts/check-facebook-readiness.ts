#!/usr/bin/env node
'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const { checkFacebookPublishReadiness } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/facebook-publisher.ts'));
const { buildBlogCliInsight } = require('../lib/cli-insight.ts');

function parseArgs(argv = []) {
  return {
    json: argv.includes('--json'),
  };
}

function buildActions(readiness = {}) {
  const actions = [];
  if (!readiness?.pageId) actions.push('허브 저장소에 facebook/instagram page_id 연결 상태 확인');
  if (Array.isArray(readiness?.permissionScopes) && readiness.permissionScopes.length > 0) {
    actions.push(`Meta 앱 권한 재연결: ${readiness.permissionScopes.join(', ')}`);
    actions.push('페이지 권한 재연결 후 페이지 access token 다시 발급');
  }
  if (!readiness?.ready && !actions.length) {
    actions.push('check:facebook 결과의 readiness/error 원인을 먼저 점검');
  }
  if (actions.length === 0) {
    actions.push(`npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run publish:facebook -- --dry-run`);
  }
  return actions;
}

function buildFacebookReadinessFallback(payload = {}) {
  if (!payload.ready) {
    return '페이스북 자동등록 준비가 아직 불완전해 page 연결과 권한 scope를 먼저 확인하는 편이 좋습니다.';
  }
  return '페이스북 자동등록 준비는 갖춰져 있어 dry-run 또는 실게시로 마지막 점검만 하면 됩니다.';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const readiness = await checkFacebookPublishReadiness();
  /** @type {any} */
  const payload = {
    ready: Boolean(readiness?.ready),
    credentialSource: readiness?.credentialSource || 'unknown',
    pageId: readiness?.pageId || '',
    permissionScopes: Array.isArray(readiness?.permissionScopes) ? readiness.permissionScopes : [],
    error: String(readiness?.error || ''),
    actions: buildActions(readiness),
  };

  const aiSummary = await buildBlogCliInsight({
    bot: 'check-facebook-readiness',
    requestType: 'check-facebook-readiness',
    title: '블로그 페이스북 readiness 요약',
    data: {
      ready: payload.ready,
      credentialSource: payload.credentialSource,
      pageId: payload.pageId,
      permissionScopes: payload.permissionScopes,
      error: payload.error,
      actions: payload.actions,
    },
    fallback: buildFacebookReadinessFallback(payload),
  });
  payload.aiSummary = aiSummary;

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[facebook readiness] ready=${payload.ready ? 'yes' : 'no'} source=${payload.credentialSource}`);
  console.log(`🔍 AI: ${payload.aiSummary}`);
  console.log(`[facebook readiness] page=${payload.pageId || 'missing'}`);
  console.log(`[facebook readiness] scopes=${payload.permissionScopes.length ? payload.permissionScopes.join(', ') : 'ok'}`);
  if (payload.error) {
    console.log(`[facebook readiness] error=${payload.error}`);
  }
  for (const action of payload.actions) {
    console.log(`- ${action}`);
  }
}

main().catch((error) => {
  console.error('[facebook readiness] 실패:', error?.message || error);
  process.exit(1);
});
