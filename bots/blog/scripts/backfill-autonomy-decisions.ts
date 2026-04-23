#!/usr/bin/env node
'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const pgPool = require('../../../packages/core/lib/pg-pool');
const { ensureBlogCoreSchema } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/schema.ts'));
const { decideAutonomy } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/autonomy-gate.ts'));

function parseArgs(argv = []) {
  const args = {
    json: argv.includes('--json'),
    dryRun: argv.includes('--dry-run'),
    days: 14,
    limit: 20,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--days') args.days = Math.max(1, Number(argv[i + 1] || 14));
    if (token === '--limit') args.limit = Math.max(1, Number(argv[i + 1] || 20));
  }

  return args;
}

function safeJson(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function buildPostInput(row) {
  const metadata = safeJson(row.metadata, {});
  const imageUrls = Array.isArray(row.image_urls) ? row.image_urls : [];
  const autonomyFromMetadata = metadata?.autonomy && typeof metadata.autonomy === 'object'
    ? metadata.autonomy
    : null;

  const input = {
    title: row.title || '',
    content: row.content || row.html_content || '',
    thumbnailPath: imageUrls[0] || null,
    postType: row.post_type || 'general',
    category: row.category || '',
  };

  return { input, metadata, autonomyFromMetadata };
}

async function loadCandidates({ days, limit }) {
  return pgPool.query('blog', `
    SELECT
      p.id,
      p.title,
      p.category,
      p.post_type,
      p.publish_date,
      p.status,
      p.content,
      p.html_content,
      p.image_urls,
      p.metadata,
      p.created_at
    FROM blog.posts p
    WHERE p.status IN ('ready', 'published')
      AND p.created_at >= NOW() - ($1::text || ' days')::interval
      AND COALESCE(NULLIF(p.metadata->>'exclude_from_reference', '')::boolean, false) = false
      AND NOT EXISTS (
        SELECT 1
        FROM blog.autonomy_decisions ad
        WHERE ad.post_id = p.id
      )
    ORDER BY p.created_at DESC
    LIMIT $2
  `, [String(days), limit]);
}

async function insertDecision(row, autonomy, metadata, dryRun = false) {
  const payload = {
    backfilled: true,
    backfill_source: 'backfill-autonomy-decisions',
    writer_name: metadata?.writer_name || null,
    filename: metadata?.filename || null,
  };

  if (dryRun) {
    return {
      dryRun: true,
      postId: row.id,
      title: row.title,
      decision: autonomy.decision,
    };
  }

  await pgPool.run('blog', `
    INSERT INTO blog.autonomy_decisions
      (decision_date, post_type, category, title, post_id, autonomy_phase, decision, score, threshold, reasons, sense_summary, revenue_summary, metadata)
    VALUES
      ($1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb)
  `, [
    row.publish_date || row.created_at,
    row.post_type || 'general',
    row.category || null,
    row.title || '',
    row.id,
    Number(autonomy.phase || 1),
    autonomy.decision || 'auto_publish_guarded',
    Number(autonomy.score || 0),
    Number(autonomy.threshold || 0),
    JSON.stringify(Array.isArray(autonomy.reasons) ? autonomy.reasons : []),
    JSON.stringify(autonomy.senseSummary || {}),
    JSON.stringify(autonomy.revenueSummary || {}),
    JSON.stringify(payload),
  ]);

  return {
    dryRun: false,
    postId: row.id,
    title: row.title,
    decision: autonomy.decision,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await ensureBlogCoreSchema();

  const rows = await loadCandidates(args);
  const processed = [];
  let inserted = 0;
  let autoPublishCount = 0;
  let guardedPublishCount = 0;
  let holdCount = 0;

  for (const row of rows) {
    const { input, metadata, autonomyFromMetadata } = buildPostInput(row);
    const autonomy = autonomyFromMetadata || await decideAutonomy(input);
    const result = await insertDecision(row, autonomy, metadata, args.dryRun);

    processed.push({
      postId: row.id,
      title: row.title,
      postType: row.post_type,
      category: row.category,
      decision: autonomy.decision,
      score: Number(autonomy.score || 0),
      threshold: Number(autonomy.threshold || 0),
      source: autonomyFromMetadata ? 'metadata.autonomy' : 'decideAutonomy',
    });

    inserted += 1;
    if (autonomy.decision === 'auto_publish') autoPublishCount += 1;
    if (autonomy.decision === 'auto_publish_guarded' || autonomy.decision === 'master_review') guardedPublishCount += 1;
    if (autonomy.decision === 'quality_hold') holdCount += 1;
  }

  const payload = {
    dryRun: args.dryRun,
    scanned: rows.length,
    inserted,
    autoPublishCount,
    guardedPublishCount,
    holdCount,
    items: processed,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[autonomy backfill] scanned=${payload.scanned} inserted=${payload.inserted} auto=${payload.autoPublishCount} guarded=${payload.guardedPublishCount} hold=${payload.holdCount} dryRun=${payload.dryRun}`);
  processed.slice(0, 10).forEach((item) => {
    console.log(`- #${item.postId} [${item.postType}] ${item.decision} (${item.score}/${item.threshold}) ${item.title}`);
  });
}

main().catch((error) => {
  console.error('[autonomy backfill] 실패:', error?.message || error);
  process.exit(1);
});
