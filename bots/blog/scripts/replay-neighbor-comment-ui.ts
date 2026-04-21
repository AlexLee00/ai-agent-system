#!/usr/bin/env node
'use strict';

const pgPool = require('../../../packages/core/lib/pg-pool');
const {
  ensureSchema,
  processNeighborCommentWithTimeout,
} = require('../lib/commenter.ts');

function parseArgs(argv = []) {
  const parsed = { json: false, id: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    if (token === '--json') {
      parsed.json = true;
      continue;
    }
    if (token.startsWith('--id=')) {
      parsed.id = Number(token.split('=')[1] || 0);
      continue;
    }
    if (token === '--id') {
      parsed.id = Number(argv[i + 1] || 0);
      i += 1;
    }
  }
  return parsed;
}

async function resolveCandidate(id = 0) {
  if (Number(id || 0) > 0) {
    return pgPool.get('blog', `
      SELECT *
      FROM blog.neighbor_comments
      WHERE id = $1
      LIMIT 1
    `, [Number(id)]);
  }

  return pgPool.get('blog', `
    SELECT *
    FROM blog.neighbor_comments
    WHERE timezone('Asia/Seoul', created_at)::date = timezone('Asia/Seoul', now())::date
      AND status IN ('failed', 'pending')
    ORDER BY
      CASE WHEN status = 'failed' THEN 0 ELSE 1 END,
      created_at DESC
    LIMIT 1
  `);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await ensureSchema();
  const candidate = await resolveCandidate(args.id);

  if (!candidate?.id) {
    const payload = { ok: false, reason: 'neighbor_candidate_not_found', requestedId: Number(args.id || 0) };
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(`SKIPPED: ${payload.reason}`);
    return;
  }

  try {
    const result = await processNeighborCommentWithTimeout(candidate, { testMode: true });
    const payload = {
      ok: true,
      candidate: {
        id: candidate.id,
        status: candidate.status,
        targetBlogId: candidate.target_blog_id,
        targetBlogName: candidate.target_blog_name,
        postUrl: candidate.post_url,
        postTitle: candidate.post_title,
      },
      result,
    };
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(`candidate=${candidate.id} ok=${result?.ok === true} skipped=${result?.skipped === true}`);
  } catch (error) {
    const payload = {
      ok: false,
      reason: String(error?.message || error),
      candidate: {
        id: candidate.id,
        status: candidate.status,
        targetBlogId: candidate.target_blog_id,
        postUrl: candidate.post_url,
      },
    };
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
      process.exit(1);
    }
    console.error(`❌ ${payload.reason}`);
    process.exit(1);
  }
}

main().finally(async () => {
  await pgPool.closeAll().catch(() => {});
});
