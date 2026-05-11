'use strict';
// @ts-nocheck

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const pgPool = require('../../../packages/core/lib/pg-pool');
const { ensureBlogCoreSchema } = require('../lib/schema.ts');
const {
  parseNaverEditorDocumentFromFile,
} = require('../lib/naver-ui/html-to-editor-blocks.ts');
const {
  resolveSafeScheduledAt,
} = require('../lib/naver-ui/scheduled-publish-policy.ts');
const {
  getPublishAssistConfig,
  runNaverScheduledPublishAssist,
} = require('../lib/naver-ui/driver.ts');
const {
  recordNaverScheduledReview,
} = require('../lib/naver-ui/scheduled-review-store.ts');

const OUTPUT_DIR = path.join(env.PROJECT_ROOT, 'bots', 'blog', 'output');
const OPS_DIR = path.join(OUTPUT_DIR, 'ops');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    json: false,
    apply: false,
    dryRun: true,
    confirm: '',
    postId: null,
    html: '',
    scheduleAt: '',
    scheduleDays: null,
  };
  for (const arg of argv) {
    if (arg === '--json') args.json = true;
    else if (arg === '--apply') {
      args.apply = true;
      args.dryRun = false;
    } else if (arg === '--dry-run') {
      args.apply = false;
      args.dryRun = true;
    } else if (arg.startsWith('--confirm=')) args.confirm = arg.slice('--confirm='.length);
    else if (arg.startsWith('--post-id=')) args.postId = Number(arg.slice('--post-id='.length));
    else if (arg.startsWith('--html=')) args.html = arg.slice('--html='.length);
    else if (arg.startsWith('--schedule-at=')) args.scheduleAt = arg.slice('--schedule-at='.length);
    else if (arg.startsWith('--schedule-days=')) args.scheduleDays = Number(arg.slice('--schedule-days='.length));
  }
  return args;
}

function safeJson(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

async function loadPostById(postId) {
  await ensureBlogCoreSchema();
  return pgPool.get('blog', `
    SELECT id, title, content, metadata, status, created_at
    FROM blog.posts
    WHERE id = $1
  `, [postId]);
}

async function loadLatestReadyPost() {
  await ensureBlogCoreSchema();
  return pgPool.get('blog', `
    SELECT id, title, content, metadata, status, created_at
    FROM blog.posts
    WHERE status = 'ready'
    ORDER BY created_at DESC
    LIMIT 1
  `);
}

function resolveHtmlPath({ explicitHtml, post }) {
  if (explicitHtml) {
    return path.isAbsolute(explicitHtml)
      ? explicitHtml
      : path.join(env.PROJECT_ROOT, explicitHtml);
  }

  const metadata = safeJson(post?.metadata, {});
  const filename = metadata.filename;
  if (!filename) {
    throw new Error(`post ${post?.id || 'unknown'} has no metadata.filename`);
  }
  return path.join(OUTPUT_DIR, filename);
}

function writeLatest(result) {
  fs.mkdirSync(OPS_DIR, { recursive: true });
  const outPath = path.join(OPS_DIR, 'naver-publish-assist-latest.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
  return outPath;
}

async function main() {
  const args = parseArgs();
  const config = getPublishAssistConfig();
  const post = args.html
    ? null
    : (args.postId ? await loadPostById(args.postId) : await loadLatestReadyPost());

  if (!args.html && !post) {
    throw new Error(args.postId ? `blog post not found: ${args.postId}` : 'no ready blog post found');
  }

  const htmlPath = resolveHtmlPath({ explicitHtml: args.html, post });
  if (!fs.existsSync(htmlPath)) {
    throw new Error(`html file not found: ${htmlPath}`);
  }

  const document = parseNaverEditorDocumentFromFile(htmlPath);
  if (post?.title && !document.title) document.title = post.title;

  const scheduledAt = resolveSafeScheduledAt({
    requestedAt: args.scheduleAt || null,
    minDays: args.scheduleDays || config.minScheduleDays || 5,
    hour: config.scheduleHour ?? 7,
    minute: config.scheduleMinute ?? 0,
  });

  const result = await runNaverScheduledPublishAssist({
    document,
    scheduledAt,
    apply: args.apply,
    dryRun: args.dryRun,
    confirm: args.confirm,
    config,
  });

  let record = null;
  if (args.apply && result.status === 'naver_scheduled_publish_submitted' && post?.id) {
    record = await recordNaverScheduledReview({
      postId: post.id,
      title: document.title,
      scheduledAt,
      result,
    });
  }

  const output = {
    ok: result.ok !== false,
    dryRun: !args.apply,
    postId: post?.id || null,
    htmlPath,
    title: document.title,
    scheduledAt,
    result,
    record,
  };
  const outputPath = writeLatest(output);
  output.outputPath = outputPath;

  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`[naver-publish-assist] ${output.dryRun ? 'dry-run' : 'apply'} ${output.result.status} → ${outputPath}`);
  }
}

main()
  .catch((error) => {
    const payload = {
      ok: false,
      error: error?.message || String(error),
      stack: process.env.DEBUG ? error?.stack : undefined,
    };
    writeLatest(payload);
    console.error(JSON.stringify(payload, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pgPool.closeAll?.();
  });
