#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const pgPool = require('../../../packages/core/lib/pg-pool.js');
const { postReply, generateReply, getPostSummary } = require('../lib/commenter.ts');

const BLOG_COMMENTER_DEBUG_DIR = '/Users/alexlee/projects/ai-agent-system/tmp/blog-commenter-debug';

function parseArgs(argv = []) {
  const args = {
    commentId: null,
    json: argv.includes('--json'),
    useLatest: argv.includes('--latest') || !argv.some((token) => token.startsWith('--comment-id')),
    timeoutMs: 20000,
    worker: argv.includes('--worker'),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--comment-id' && argv[index + 1]) {
      args.commentId = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (token === '--timeout-ms' && argv[index + 1]) {
      const next = Number(argv[index + 1]);
      if (Number.isFinite(next) && next > 0) {
        args.timeoutMs = next;
      }
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
    ORDER BY a.executed_at DESC
    LIMIT 1
  `);
  if (recentFailure) return recentFailure;

  const todayComment = await pgPool.get('blog', `
    SELECT *
    FROM blog.comments
    WHERE timezone('Asia/Seoul', detected_at)::date = timezone('Asia/Seoul', now())::date
    ORDER BY detected_at DESC
    LIMIT 1
  `);
  if (todayComment) return todayComment;

  const recentComment = await pgPool.get('blog', `
    SELECT *
    FROM blog.comments
    WHERE detected_at >= now() - interval '7 days'
    ORDER BY detected_at DESC
    LIMIT 1
  `);
  if (recentComment) return recentComment;

  return pgPool.get('blog', `
    SELECT *
    FROM blog.comments
    ORDER BY detected_at DESC NULLS LAST, id DESC
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

function extractLogNo(postUrl) {
  const raw = String(postUrl || '');
  const match = raw.match(/(?:logNo=|\/)(\d{6,})/);
  return match ? String(match[1]) : '';
}

function loadLatestDebugSnapshot(logNo) {
  try {
    if (!logNo || !fs.existsSync(BLOG_COMMENTER_DEBUG_DIR)) return null;
    const files = fs.readdirSync(BLOG_COMMENTER_DEBUG_DIR)
      .filter((name) => name.endsWith(`-${logNo}.json`))
      .map((name) => ({
        name,
        fullPath: path.join(BLOG_COMMENTER_DEBUG_DIR, name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const latest = files[files.length - 1];
    if (!latest) return null;
    const data = JSON.parse(fs.readFileSync(latest.fullPath, 'utf8'));
    return {
      file: latest.name,
      url: String(data?.url || ''),
      targetReplyAreaVisible: Boolean(data?.targetReplyAreaVisible),
      targetReplyButtonText: String(data?.targetReplyButtonText || ''),
      editorId: String(data?.editorState?.id || ''),
      editorClassName: String(data?.editorState?.className || ''),
      editorVisible: Boolean(data?.editorState?.visible),
      submitFound: Boolean(data?.submitButtonState?.found),
      submitText: String(data?.submitButtonState?.text || ''),
      submitDataAction: String(data?.submitButtonState?.dataAction || ''),
      submitUiSelector: String(data?.submitButtonState?.uiSelector || ''),
      submitClassName: String(data?.submitButtonState?.className || ''),
      commentSurfaceState: data?.commentSurfaceState || null,
    };
  } catch {
    return null;
  }
}

function buildTimeoutPayload({ comment, replyText, timeoutMs }) {
  const logNo = extractLogNo(comment?.post_url);
  return {
    ok: false,
    dryRun: true,
    testMode: true,
    timeoutMs,
    comment: {
      id: comment.id,
      status: comment.status,
      commenterName: comment.commenter_name,
      postUrl: comment.post_url,
      commentText: String(comment.comment_text || '').slice(0, 120),
    },
    replyLength: replyText.length,
    result: null,
    error: `reply_replay_timeout:${timeoutMs}`,
    latestSnapshot: loadLatestDebugSnapshot(logNo),
  };
}

async function runWorker(args) {
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
    operationTimeoutMs: args.timeoutMs,
  });

  const payload = {
    ok: Boolean(result?.ok),
    dryRun: true,
    testMode: true,
    timeoutMs: args.timeoutMs,
    comment: {
      id: comment.id,
      status: comment.status,
      commenterName: comment.commenter_name,
      postUrl: comment.post_url,
      commentText: String(comment.comment_text || '').slice(0, 120),
    },
    replyLength: replyText.length,
    result,
    error: '',
  };

  console.log(JSON.stringify(payload));
}

async function runParent(args) {
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

  const timeoutPayload = buildTimeoutPayload({ comment, replyText, timeoutMs: args.timeoutMs });
  const childArgs = [
    __filename,
    '--worker',
    '--comment-id', String(comment.id),
    '--timeout-ms', String(args.timeoutMs),
  ];

  const child = spawn(process.execPath, childArgs, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk || ''); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk || ''); });

  const outcome = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const watchdog = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ timedOut: true, code: 124 });
    }, args.timeoutMs + 1500);

    child.once('error', (error) => {
      clearTimeout(watchdog);
      finish({ timedOut: false, code: 1, error });
    });

    child.once('exit', (code) => {
      clearTimeout(watchdog);
      finish({ timedOut: false, code: Number(code || 0) });
    });
  });

  if (outcome.timedOut) {
    if (args.json) {
      console.log(JSON.stringify(timeoutPayload, null, 2));
    } else {
      console.log(`ok=false commentId=${comment.id} status=${comment.status} stage=n/a replyLength=${replyText.length} timeoutMs=${args.timeoutMs}`);
      console.log(`error=${timeoutPayload.error}`);
    }
    process.exitCode = 124;
    return;
  }

  const trimmed = String(stdout || '').trim();
  if (trimmed) {
    if (args.json) {
      try {
        const parsed = JSON.parse(trimmed);
        console.log(JSON.stringify(parsed, null, 2));
      } catch {
        console.log(trimmed);
      }
    } else {
      console.log(trimmed);
    }
  }

  if (!trimmed && stderr) {
    if (args.json) {
      console.log(JSON.stringify({ ...timeoutPayload, error: stderr.trim() }, null, 2));
    } else {
      console.log(`ok=false commentId=${comment.id} status=${comment.status} stage=n/a replyLength=${replyText.length} timeoutMs=${args.timeoutMs}`);
      console.log(`error=${stderr.trim()}`);
    }
  }

  if (outcome.code !== 0) {
    process.exitCode = outcome.code;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.worker) {
    await runWorker(args);
    return;
  }
  await runParent(args);
}

main()
  .catch(async (error) => {
    console.error(`❌ ${error?.stack || error?.message || String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pgPool.closeAll().catch(() => {});
  });
