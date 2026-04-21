#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const pgPool = require('../../../packages/core/lib/pg-pool.js');
const { diagnoseSympathyUi } = require('../lib/commenter.ts');

const BLOG_OPS_DIR = path.join(env.PROJECT_ROOT, 'bots', 'blog', 'output', 'ops');
const NEIGHBOR_SYMPATHY_REPLAY_PATH = path.join(BLOG_OPS_DIR, 'neighbor-sympathy-replay.json');

function parseArgs(argv = []) {
  return {
    json: argv.includes('--json'),
    candidateId: readOption(argv, '--candidate-id'),
  };
}

function readOption(argv = [], flag = '') {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] || '' : '';
}

async function getCandidateById(id = '') {
  if (!id) return null;
  return pgPool.get('blog', `
    SELECT id, post_url, target_blog_id, target_blog_name, post_title, status
    FROM blog.neighbor_comments
    WHERE id = $1
  `, [Number(id)]);
}

async function getLatestCandidate() {
  return pgPool.get('blog', `
    SELECT id, post_url, target_blog_id, target_blog_name, post_title, status
    FROM blog.neighbor_comments
    ORDER BY
      CASE WHEN status = 'failed' THEN 0 ELSE 1 END,
      created_at DESC
    LIMIT 1
  `);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const candidate = (await getCandidateById(args.candidateId)) || (await getLatestCandidate());
  if (!candidate?.post_url) {
    const payload = { ok: false, error: 'neighbor_candidate_not_found' };
    fs.mkdirSync(BLOG_OPS_DIR, { recursive: true });
    fs.writeFileSync(NEIGHBOR_SYMPATHY_REPLAY_PATH, JSON.stringify(payload, null, 2));
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.error(payload.error);
    process.exit(1);
  }

  const result = await diagnoseSympathyUi(candidate.post_url, { testMode: true });
  const payload = {
    ok: Boolean(result?.ok),
    replayedAt: new Date().toISOString(),
    candidate: {
      id: candidate.id,
      postUrl: candidate.post_url,
      targetBlogId: candidate.target_blog_id,
      targetBlogName: candidate.target_blog_name,
      postTitle: candidate.post_title,
      status: candidate.status,
    },
    result,
  };
  fs.mkdirSync(BLOG_OPS_DIR, { recursive: true });
  fs.writeFileSync(NEIGHBOR_SYMPATHY_REPLAY_PATH, JSON.stringify(payload, null, 2));

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[neighbor sympathy replay] candidate=${candidate.id} ok=${payload.ok ? 'yes' : 'no'}`);
  if (result?.error) {
    console.log(`[neighbor sympathy replay] error=${result.error}`);
  }
  console.log(`[neighbor sympathy replay] controls=${result?.controls?.candidateCount || 0}`);
}

main().catch((error) => {
  const payload = {
    ok: false,
    replayedAt: new Date().toISOString(),
    error: String(error?.message || error),
  };
  fs.mkdirSync(BLOG_OPS_DIR, { recursive: true });
  fs.writeFileSync(NEIGHBOR_SYMPATHY_REPLAY_PATH, JSON.stringify(payload, null, 2));
  console.error('[neighbor sympathy replay] 실패:', error?.message || error);
  process.exit(1);
}).finally(async () => {
  await pgPool.closeAll().catch(() => {});
});
