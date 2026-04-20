#!/usr/bin/env node
'use strict';

const pgPool = require('../../../packages/core/lib/pg-pool.js');
const { postReply, generateReply, getPostSummary } = require('../lib/commenter.ts');

function parseArgs(argv = []) {
  const args = {
    commentId: null,
    json: argv.includes('--json'),
    useLatest: argv.includes('--latest') || !argv.some((token) => token.startsWith('--comment-id')),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--comment-id' && argv[index + 1]) {
      args.commentId = Number(argv[index + 1]);
      index += 1;
    }
  }

  return args;
}

async function loadCommentById(commentId) {
  return pgPool.get('blog', `
    SELECT *
    FROM blog.comments
    WHERE id = $1
    LIMIT 1
  `, [commentId]);
}

async function loadLatestReplayCandidate() {
  const recentFailure = await pgPool.get('blog', `
    SELECT c.*
    FROM blog.comment_actions a
    JOIN blog.comments c
      ON (a.meta->>'commentId')::int = c.id
    WHERE a.action_type = 'reply'
      AND a.success = false
      AND timezone('Asia/Seoul', a.executed_at)::date = timezone('Asia/Seoul', now())::date
    ORDER BY a.executed_at DESC
    LIMIT 1
  `);
  if (recentFailure) return recentFailure;

  return pgPool.get('blog', `
    SELECT *
    FROM blog.comments
    WHERE timezone('Asia/Seoul', detected_at)::date = timezone('Asia/Seoul', now())::date
    ORDER BY detected_at DESC
    LIMIT 1
  `);
}

async function resolveReplyText(comment) {
  const existing = String(comment?.reply_text || '').trim();
  if (existing) return existing;

  const postInfo = await getPostSummary(comment.post_url, { testMode: true });
  const generated = await generateReply(postInfo.title || comment.post_title, postInfo.summary, comment.comment_text);
  return String(generated?.reply || '').trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const comment = args.commentId
    ? await loadCommentById(args.commentId)
    : await loadLatestReplayCandidate();

  if (!comment?.id) {
    throw new Error('reply_replay_comment_not_found');
  }

  const replyText = await resolveReplyText(comment);
  if (!replyText) {
    throw new Error('reply_replay_text_not_found');
  }

  const result = await postReply(comment, replyText, {
    testMode: true,
    dryRun: true,
  });

  const payload = {
    ok: Boolean(result?.ok),
    dryRun: true,
    testMode: true,
    comment: {
      id: comment.id,
      status: comment.status,
      commenterName: comment.commenter_name,
      postUrl: comment.post_url,
      commentText: String(comment.comment_text || '').slice(0, 120),
    },
    replyLength: replyText.length,
    result,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`ok=${payload.ok} commentId=${comment.id} status=${comment.status} stage=${result?.stage || 'n/a'} replyLength=${replyText.length}`);
}

main()
  .catch(async (error) => {
    console.error(`❌ ${error?.stack || error?.message || String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pgPool.closeAll().catch(() => {});
  });
