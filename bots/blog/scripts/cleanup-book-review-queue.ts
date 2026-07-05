#!/usr/bin/env node
// @ts-nocheck
'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const pgPool = require('../../../packages/core/lib/pg-pool');
const {
  buildBookReviewQueueCleanupPlan,
} = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/skills/blog/book-review-book.js'));

function parseArgs(argv = []) {
  const args = {
    apply: argv.includes('--apply'),
    json: argv.includes('--json'),
    limit: 5000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--limit') args.limit = Number(argv[i + 1] || args.limit);
    const match = String(argv[i]).match(/^--limit=(\d+)$/);
    if (match) args.limit = Number(match[1]);
  }
  args.dryRun = !args.apply;
  args.limit = Math.max(1, Math.min(Number(args.limit || 5000), 20000));
  return args;
}

async function loadQueuedRows(limit) {
  const rows = await pgPool.query('blog', `
    SELECT id, queue_date, title, author, isbn, category, priority, status, source, metadata, created_at, updated_at
    FROM blog.book_review_queue
    WHERE status = 'queued'
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}
  `);
  return Array.isArray(rows) ? rows : [];
}

async function archiveDuplicates(plan) {
  let archived = 0;
  for (const group of plan.groups || []) {
    for (const id of group.duplicateIds || []) {
      const result = await pgPool.run('blog', `
        UPDATE blog.book_review_queue
        SET status = 'archived_duplicate',
            metadata = COALESCE(metadata, '{}'::jsonb) || ?::jsonb,
            updated_at = NOW()
        WHERE id = ?
          AND status = 'queued'
      `, [
        JSON.stringify({
          archivedDuplicateOf: group.keepId,
          archivedDuplicateAt: new Date().toISOString(),
          cleanupReason: 'book_review_queue_dedupe',
        }),
        id,
      ]);
      archived += Number(result?.rowCount || 0);
    }
  }
  return archived;
}

async function run(options = {}) {
  const rows = await loadQueuedRows(options.limit || 5000);
  const plan = buildBookReviewQueueCleanupPlan(rows);
  const archived = options.apply ? await archiveDuplicates(plan) : 0;
  return {
    ok: true,
    dryRun: !options.apply,
    applied: !!options.apply,
    archived,
    ...plan,
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  run(args).then((result) => {
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`[book_queue_cleanup] rows=${result.totalRows} unique=${result.uniqueBooks} duplicateRows=${result.duplicateRows} dryRun=${result.dryRun}`);
    for (const group of result.groups.slice(0, 20)) {
      console.log(`- keep ${group.keepId}: ${group.title} / archive ${group.duplicateIds.join(', ')}`);
    }
  }).catch((error) => {
    console.error('[book_queue_cleanup] 실패:', error?.message || error);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  run,
};
