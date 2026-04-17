const commenter = require('../bots/blog/lib/commenter.ts');
const pgPool = require('../packages/core/lib/pg-pool');

async function main() {
  const commentId = 1492;
  const comment = await pgPool.get('blog', 'SELECT * FROM blog.comments WHERE id = $1', [commentId]);
  if (!comment) throw new Error('comment_not_found');

  const existing = await pgPool.get(
    'blog',
    `
      SELECT id
      FROM blog.comment_actions
      WHERE action_type = 'reply'
        AND success = true
        AND (
          (meta->>'commentId')::int = $1
          OR (
            target_post_url = $2
            AND COALESCE(meta->>'commenterName', '') = $3
          )
        )
      ORDER BY executed_at DESC
      LIMIT 1
    `,
    [commentId, String(comment.post_url || ''), String(comment.commenter_name || '')],
  );

  if (existing?.id || comment.reply_at || String(comment.status || '') === 'replied') {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'already_replied', commentId }));
    return;
  }

  const postInfo = await commenter.getPostSummary(comment.post_url, {});
  const generated = await commenter.generateReply(postInfo.title || comment.post_title, postInfo.summary, comment.comment_text);
  const validation = commenter.validateReply(generated.reply, comment.comment_text);
  if (!validation.ok) {
    throw new Error(`validation_failed:${validation.reason}`);
  }

  await commenter.postReply(comment, generated.reply, {});

  await pgPool.run(
    'blog',
    `
      UPDATE blog.comments
      SET status = 'replied',
          reply_text = $2,
          error_message = NULL,
          reply_at = NOW(),
          meta = COALESCE(meta, '{}'::jsonb) || $3::jsonb
      WHERE id = $1
    `,
    [commentId, generated.reply, JSON.stringify({ tone: generated.tone || null, phase: 'manual_recovery' })],
  );

  const targetBlog = await commenter.resolveBlogId();
  await pgPool.run(
    'blog',
    `
      INSERT INTO blog.comment_actions (action_type, target_blog, target_post_url, comment_text, success, meta)
      VALUES ('reply', $1, $2, $3, true, $4::jsonb)
    `,
    [
      targetBlog || null,
      comment.post_url,
      generated.reply,
      JSON.stringify({ commentId, commenterName: comment.commenter_name || null, source: 'manual_recovery' }),
    ],
  );

  console.log(JSON.stringify({ ok: true, commentId, reply: generated.reply }));
}

main().catch((error) => {
  console.error(String((error && error.stack) || error));
  process.exit(1);
});
