#!/usr/bin/env tsx
// @ts-nocheck
'use strict';

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const env = require('../../../packages/core/lib/env');

async function main() {
  const json = process.argv.includes('--json');
  const serverModule = await import(pathToFileURL(
    path.join(env.PROJECT_ROOT, 'bots/blog/mcp/blog-naver-mcp/src/server.ts')
  ).href);
  const seo = await serverModule.callBlogNaverTool('naver_seo_score', {
    title: 'AI 도구 자동화 기준 3가지',
    category: '최신IT트렌드',
    content: 'AI 도구를 실제 업무에 남기려면 기준이 필요합니다. '.repeat(80),
  });
  const exposure = await serverModule.callBlogNaverTool('naver_exposure_audit', {
    title: 'AI 도구 자동화 기준 3가지',
    category: '최신IT트렌드',
    content: '제가 직접 써보니 기준이 중요했습니다. '.repeat(80),
  });

  assert.equal(seo.ok, true);
  assert.equal(seo.readOnly, true);
  assert.equal(exposure.ok, true);
  assert.equal(exposure.readOnly, true);
  assert.ok(exposure.result.channels.length === 8);

  const result = {
    ok: true,
    shadowMode: true,
    tools: serverModule.BLOG_NAVER_MCP_TOOLS.map((tool) => tool.name),
    exposureChannels: exposure.result.channels.length,
  };
  if (json) console.log(JSON.stringify(result));
  else console.log('[blog-naver-mcp-smoke] ok', result);
}

main().catch((error) => {
  const result = { ok: false, error: error?.message || String(error) };
  if (process.argv.includes('--json')) console.log(JSON.stringify(result));
  else console.error('[blog-naver-mcp-smoke] failed:', result.error);
  process.exit(1);
});
