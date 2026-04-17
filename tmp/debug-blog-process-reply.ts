const pgPool = require('../packages/core/lib/pg-pool');
const commenter = require('../bots/blog/lib/commenter.ts');

async function main() {
  const id = Number(process.argv[2] || 0);
  const testMode = process.env.BLOG_COMMENTER_TEST === 'true';
  if (!id) throw new Error('comment_id_required');

  const row = await pgPool.get(
    'blog',
    `
      SELECT *
      FROM blog.comments
      WHERE id = $1
    `,
    [id],
  );

  if (!row) throw new Error(`comment_not_found:${id}`);

  const result = await commenter.processCommentWithTimeout(row, { testMode });
  console.log(JSON.stringify({ id, testMode, result }, null, 2));
}

main().catch((error) => {
  console.error(String(error?.stack || error));
  process.exit(1);
});
