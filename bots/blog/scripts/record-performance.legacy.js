#!/usr/bin/env node
'use strict';

const path = require('path');
const pgPool = require(path.join(__dirname, '../../../packages/core/lib/pg-pool'));
const { recordPerformance, getPerformanceCollectionCandidates } = require('../lib/publ');

function parseArgs(argv = process.argv.slice(2)) {
  const get = (name) => argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=') || null;
  return {
    postId: get('post-id'),
    scheduleId: get('schedule-id'),
    views: Number(get('views') || 0),
    comments: Number(get('comments') || 0),
    likes: Number(get('likes') || 0),
    listOnly: argv.includes('--list'),
  };
}

async function resolvePostId({ postId, scheduleId }) {
  if (postId) return Number(postId);
  if (!scheduleId) throw new Error('--post-id 또는 --schedule-id 중 하나가 필요합니다.');

  const row = await pgPool.get('blog', `
    SELECT id
    FROM blog.posts
    WHERE metadata->>'schedule_id' = $1
    ORDER BY created_at DESC
    LIMIT 1
  `, [String(scheduleId)]);
  if (!row?.id) throw new Error('대상 포스트를 찾을 수 없습니다.');
  return Number(row.id);
}

async function main() {
  const args = parseArgs();

  if (args.listOnly) {
    const rows = await getPerformanceCollectionCandidates(7);
    rows.forEach((row) => {
      console.log(`${row.id}\t${row.publish_date}\t${row.category}\t${row.title}`);
    });
    return;
  }

  const targetPostId = await resolvePostId(args);
  const result = await recordPerformance(targetPostId, {
    views: args.views,
    comments: args.comments,
    likes: args.likes,
  });

  if (!result) throw new Error('성과 저장 실패');
  console.log(JSON.stringify({
    ok: true,
    postId: targetPostId,
    views: args.views,
    comments: args.comments,
    likes: args.likes,
  }, null, 2));
}

main().catch((error) => {
  console.error(`❌ ${error?.stack || error?.message || String(error)}`);
  process.exit(1);
});
