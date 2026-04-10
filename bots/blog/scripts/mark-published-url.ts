#!/usr/bin/env node
// @ts-nocheck
'use strict';

const path = require('path');
const pgPool = require(path.join(__dirname, '../../../packages/core/lib/pg-pool'));
const { parseNaverBlogUrl } = require(path.join(__dirname, '../../../packages/core/lib/naver-blog-url'));
const { markPublished } = require('../lib/publ');

function parseArgs(argv = process.argv.slice(2)) {
  return {
    postId: argv.find((arg) => arg.startsWith('--post-id='))?.split('=')[1] || null,
    scheduleId: argv.find((arg) => arg.startsWith('--schedule-id='))?.split('=')[1] || null,
    url: argv.find((arg) => arg.startsWith('--url='))?.split('=').slice(1).join('=') || null,
    json: argv.includes('--json'),
  };
}

async function findTargetPost({ postId, scheduleId }) {
  if (postId) {
    return pgPool.get('blog', `
      SELECT id, title, status, naver_url, metadata, created_at
      FROM blog.posts
      WHERE id = $1
    `, [postId]);
  }

  if (scheduleId) {
    return pgPool.get('blog', `
      SELECT id, title, status, naver_url, metadata, created_at
      FROM blog.posts
      WHERE metadata->>'schedule_id' = $1
      ORDER BY created_at DESC
      LIMIT 1
    `, [String(scheduleId)]);
  }

  throw new Error('`--post-id` 또는 `--schedule-id` 중 하나가 필요합니다.');
}

function printHuman(result) {
  const lines = [
    '✅ 블로그 발행 URL 기록 완료',
    '',
    `- post_id: ${result.postId}`,
    `- title: ${result.title}`,
    `- status: ${result.status}`,
    `- saved_url: ${result.savedUrl}`,
    `- blogId: ${result.blogId}`,
    `- logNo: ${result.logNo}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main() {
  const { postId, scheduleId, url, json } = parseArgs();
  if (!url) {
    throw new Error('`--url=<naver_blog_url>`가 필요합니다.');
  }

  const parsed = parseNaverBlogUrl(url);
  if (!parsed.ok) {
    throw new Error(`유효한 네이버 블로그 URL이 아닙니다: ${parsed.reason}`);
  }

  const row = await findTargetPost({ postId, scheduleId });
  if (!row) {
    throw new Error('대상 blog.posts 행을 찾을 수 없습니다.');
  }

  await markPublished(row.id, parsed.canonicalUrl);

  const result = {
    postId: row.id,
    title: row.title,
    status: 'published',
    savedUrl: parsed.canonicalUrl,
    blogId: parsed.blogId,
    logNo: parsed.logNo,
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  printHuman(result);
}

main().catch((error) => {
  process.stderr.write(`❌ ${error?.stack || error?.message || String(error)}\n`);
  process.exit(1);
});
