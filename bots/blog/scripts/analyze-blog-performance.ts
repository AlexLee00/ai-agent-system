#!/usr/bin/env node
// @ts-nocheck
'use strict';

const path = require('path');
const pgPool = require(path.join(__dirname, '../../../packages/core/lib/pg-pool'));
const registry = require(path.join(__dirname, '../../../packages/core/lib/agent-registry'));
const { publishToWebhook } = require(path.join(__dirname, '../../../packages/core/lib/reporting-hub'));
const { createAgentMemory } = require(path.join(__dirname, '../../../packages/core/lib/agent-memory'));
const eventLake = require(path.join(__dirname, '../../../packages/core/lib/event-lake'));
const performanceMemory = createAgentMemory({ agentId: 'blog.performance', team: 'blog' });

function parseArgs(argv = process.argv.slice(2)) {
  const get = (name) => argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  return {
    days: Number(get('days') || 30),
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function deriveEffectiveViews(views, likes, comments) {
  const rawViews = Number(views || 0);
  if (rawViews > 0) return rawViews;
  return Number(likes || 0) * 25 + Number(comments || 0) * 40;
}

function buildMemoryQuery(rows, rankings, categoryRankings) {
  return [
    'blog performance feedback',
    `posts-${rows.length}`,
    rankings[0]?.name,
    rankings[0]?.topCategory,
    categoryRankings[0]?.category,
  ].filter(Boolean).join(' ');
}

async function loadPerformanceRows(days = 30) {
  return pgPool.query('blog', `
    SELECT
      id,
      title,
      category,
      post_type,
      publish_date,
      metadata,
      COALESCE(NULLIF(metadata->>'views', ''), '0')::double precision AS views,
      COALESCE(NULLIF(metadata->>'comments', ''), '0')::double precision AS comments,
      COALESCE(NULLIF(metadata->>'likes', ''), '0')::double precision AS likes
    FROM blog.posts
    WHERE status = 'published'
      AND publish_date >= CURRENT_DATE - $1::int
      AND metadata->>'performance_collected_at' IS NOT NULL
      AND metadata->>'performance_collected_at' <> ''
    ORDER BY publish_date DESC, id DESC
  `, [days]);
}

function resolveWriterName(row) {
  const explicit = String(row?.metadata?.writer_name || '').trim();
  if (explicit) return explicit;

  if (row?.post_type === 'lecture') return 'pos';
  if (row?.post_type === 'general') return 'gems';
  return '';
}

function aggregateByWriter(rows) {
  const stats = new Map();

  for (const row of rows) {
    const writerName = resolveWriterName(row);
    if (!writerName) continue;
    if (!stats.has(writerName)) {
      stats.set(writerName, {
        name: writerName,
        posts: 0,
        totalViews: 0,
        totalLikes: 0,
        totalComments: 0,
        categories: {},
      });
    }

    const item = stats.get(writerName);
    item.posts += 1;
    item.totalViews += Number(row.views || 0);
    item.totalLikes += Number(row.likes || 0);
    item.totalComments += Number(row.comments || 0);
    item.categories[row.category] = (item.categories[row.category] || 0) + 1;
  }

  const rankings = [...stats.values()].map((item) => {
    const avgViews = item.posts > 0 ? item.totalViews / item.posts : 0;
    const avgLikes = item.posts > 0 ? item.totalLikes / item.posts : 0;
    const avgComments = item.posts > 0 ? item.totalComments / item.posts : 0;
    const effectiveViews = deriveEffectiveViews(avgViews, avgLikes, avgComments);
    const score = effectiveViews * 0.7 + avgLikes * 20 + avgComments * 10;
    return {
      name: item.name,
      posts: item.posts,
      avgViews: round(avgViews),
      effectiveViews: round(effectiveViews),
      avgLikes: round(avgLikes),
      avgComments: round(avgComments),
      score: round(score),
      topCategory: Object.entries(item.categories).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    };
  }).sort((a, b) => b.score - a.score);

  return rankings;
}

function aggregateByCategory(rows) {
  const stats = new Map();
  for (const row of rows) {
    const category = String(row.category || 'general');
    if (!stats.has(category)) {
      stats.set(category, { category, posts: 0, totalViews: 0, totalLikes: 0, totalComments: 0 });
    }
    const item = stats.get(category);
    item.posts += 1;
    item.totalViews += Number(row.views || 0);
    item.totalLikes += Number(row.likes || 0);
    item.totalComments += Number(row.comments || 0);
  }

  return [...stats.values()]
    .map((item) => ({
      category: item.category,
      posts: item.posts,
      avgViews: round(item.totalViews / Math.max(1, item.posts)),
      avgLikes: round(item.totalLikes / Math.max(1, item.posts)),
      avgComments: round(item.totalComments / Math.max(1, item.posts)),
    }))
    .sort((a, b) => b.avgViews - a.avgViews);
}

async function applyWriterFeedback(rankings, { dryRun = false } = {}) {
  if (!rankings.length) return [];
  const avgScore = rankings.reduce((sum, item) => sum + item.score, 0) / Math.max(1, rankings.length);
  const updates = [];

  for (const writer of rankings) {
    const relativeScore = avgScore > 0 ? writer.score / avgScore : 1;
    const adjustment = clamp((relativeScore - 1.0) * 0.5, -0.5, 0.5);
    const taskScore = clamp(5 + adjustment * 5, 0, 10);
    const reason = `[blog-performance-feedback] avgViews=${writer.avgViews} avgLikes=${writer.avgLikes} avgComments=${writer.avgComments} relative=${round(relativeScore)}`;

    if (!dryRun) {
      await registry.updateScore(writer.name, taskScore, reason, null);
    }

    updates.push({
      ...writer,
      relativeScore: round(relativeScore),
      adjustment: round(adjustment),
      taskScore: round(taskScore),
    });
  }

  return updates;
}

async function sendReport(rows, rankings, categoryRankings, { dryRun = false } = {}) {
  const lines = [
    `📊 블로팀 성과 피드백 (${rows.length}건 분석)`,
    '',
    '작가별 상위:',
  ];

  rankings.slice(0, 5).forEach((item, index) => {
    const trend = item.adjustment >= 0 ? '📈' : '📉';
    lines.push(`${index + 1}. ${trend} ${item.name}: 조회수 ${item.avgViews}, 좋아요 ${item.avgLikes}, 댓글 ${item.avgComments}, 보정 ${item.adjustment > 0 ? '+' : ''}${item.adjustment}`);
  });

  if (categoryRankings.length > 0) {
    lines.push('', '카테고리별 평균 조회수:');
    categoryRankings.slice(0, 5).forEach((item) => {
      lines.push(`- ${item.category}: ${item.avgViews} (${item.posts}건)`);
    });
  }

  if (dryRun) return { ok: true, skipped: true, message: lines.join('\n') };

  const memoryQuery = buildMemoryQuery(rows, rankings, categoryRankings);
  const episodicHint = await performanceMemory.recallCountHint(memoryQuery, {
    type: 'episodic',
    limit: 2,
    threshold: 0.33,
    title: '최근 유사 피드백',
    separator: 'pipe',
    metadataKey: 'kind',
    labels: {
      feedback: '피드백',
      recovery: '회복',
    },
    order: ['feedback', 'recovery'],
  }).catch(() => '');
  const semanticHint = await performanceMemory.recallHint(`${memoryQuery} consolidated performance pattern`, {
    type: 'semantic',
    limit: 2,
    threshold: 0.28,
    title: '최근 통합 패턴',
    separator: 'newline',
  }).catch(() => '');
  const message = `${lines.join('\n')}${episodicHint}${semanticHint}`;

  const result = await publishToWebhook({
    event: {
      from_bot: 'blog-analyzer',
      team: 'blog',
      event_type: 'blog_performance_feedback',
      alert_level: 2,
      message,
    },
  });
  await performanceMemory.remember(message, 'episodic', {
    importance: 0.7,
    expiresIn: 1000 * 60 * 60 * 24 * 30,
    metadata: {
      kind: 'feedback',
      posts: rows.length,
      writers: rankings.length,
      topWriter: rankings[0]?.name || null,
      topCategory: categoryRankings[0]?.category || null,
    },
  }).catch(() => {});
  await performanceMemory.consolidate({
    olderThanDays: 14,
    limit: 10,
  }).catch(() => {});
  return result;
}

async function main() {
  const args = parseArgs();
  const rows = await loadPerformanceRows(args.days);
  if (!rows.length) {
    console.log('[analyze-blog-performance] 성과 데이터 없음 — 스킵');
    return;
  }

  const writerRankings = aggregateByWriter(rows);
  const categoryRankings = aggregateByCategory(rows);
  const applied = await applyWriterFeedback(writerRankings, { dryRun: args.dryRun });
  const reportResult = await sendReport(rows, applied, categoryRankings, { dryRun: args.dryRun });
  if (!args.dryRun) {
    eventLake.record({
      eventType: 'blog_performance_analyzed',
      team: 'blog',
      botName: 'blog-analyzer',
      severity: 'info',
      title: `blog performance ${rows.length}건`,
      message: `작가 ${applied.length}명 성과 분석 완료`,
      tags: ['blog', 'performance', 'live'],
      metadata: {
        analyzed_posts: rows.length,
        writers: applied.length,
        top_writer: applied[0]?.name || null,
        report_sent: reportResult?.ok === true,
      },
    }).catch(() => {});
  }

  const payload = {
    ok: true,
    analyzedPosts: rows.length,
    writers: applied.length,
    topWriters: applied.slice(0, 5),
    categories: categoryRankings.slice(0, 5),
    reportSent: args.dryRun ? false : reportResult?.ok === true,
    dryRun: args.dryRun,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`✅ 블로팀 성과 피드백 완료: ${rows.length}건, 작가 ${applied.length}명`);
  applied.forEach((item) => {
    console.log(`- ${item.name}: avgViews=${item.avgViews} avgLikes=${item.avgLikes} avgComments=${item.avgComments} adjustment=${item.adjustment > 0 ? '+' : ''}${item.adjustment}`);
  });
}

main().catch((error) => {
  console.error(`❌ ${error?.stack || error?.message || String(error)}`);
  process.exit(1);
});
