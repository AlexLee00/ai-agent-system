// @ts-nocheck
'use strict';
/**
 * C-Rank 점수 추적기 — I영역 (CODEX_BLOG_V3_UNIFIED_MASTER Week 3)
 *
 * 역할: 최근 발행 포스팅의 SEO 알고리즘 점수를 매일 계산 + 변화 감지
 *   - C-Rank (Context/Content/Chain/Creator)
 *   - D.I.A.+ (Intent/Depth/Uniqueness)
 *   - GEO (ai_friendliness/structure/citation)
 *
 * DB: blog.crank_scores 테이블
 * 알림: 점수 변화 ±10점 이상 시 postAlarm 경보
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');
const pgPool = require('../../../packages/core/lib/pg-pool');
const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');
const {
  calculateCRankScore,
  calculateDIAScore,
  calculateGEOScore,
  calculateNaverSEOScore,
} = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/naver-seo-optimizer.ts'));

const SCORE_CHANGE_THRESHOLD = 10; // ±10점 이상이면 알림

export async function ensureCrankScoresTable() {
  await pgPool.run('blog', `
    CREATE TABLE IF NOT EXISTS blog.crank_scores (
      id              SERIAL PRIMARY KEY,
      post_id         INTEGER NOT NULL REFERENCES blog.posts(id) ON DELETE CASCADE,
      scored_date     DATE    NOT NULL DEFAULT CURRENT_DATE,
      crank_total     INTEGER NOT NULL DEFAULT 0,
      crank_context   INTEGER NOT NULL DEFAULT 0,
      crank_content   INTEGER NOT NULL DEFAULT 0,
      crank_chain     INTEGER NOT NULL DEFAULT 0,
      crank_creator   INTEGER NOT NULL DEFAULT 0,
      dia_total       INTEGER NOT NULL DEFAULT 0,
      dia_intent      INTEGER NOT NULL DEFAULT 0,
      dia_depth       INTEGER NOT NULL DEFAULT 0,
      dia_uniqueness  INTEGER NOT NULL DEFAULT 0,
      geo_total       INTEGER NOT NULL DEFAULT 0,
      geo_ai          INTEGER NOT NULL DEFAULT 0,
      geo_structure   INTEGER NOT NULL DEFAULT 0,
      geo_citation    INTEGER NOT NULL DEFAULT 0,
      overall         INTEGER NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (post_id, scored_date)
    );
    CREATE INDEX IF NOT EXISTS idx_crank_scores_post ON blog.crank_scores(post_id, scored_date DESC);
    CREATE INDEX IF NOT EXISTS idx_crank_scores_date ON blog.crank_scores(scored_date DESC);
  `);
}

async function getRecentPublishedPosts(daysBack = 14) {
  const rows = await pgPool.run('blog', `
    SELECT id, title, category, content
    FROM blog.posts
    WHERE status = 'published'
      AND publish_date >= CURRENT_DATE - INTERVAL '${daysBack} days'
      AND content IS NOT NULL
      AND LENGTH(content) > 100
    ORDER BY publish_date DESC
    LIMIT 30
  `);
  return rows?.rows || [];
}

async function getPreviousScore(postId: number) {
  const result = await pgPool.run('blog', `
    SELECT overall, crank_total, dia_total, geo_total
    FROM blog.crank_scores
    WHERE post_id = $1
      AND scored_date < CURRENT_DATE
    ORDER BY scored_date DESC
    LIMIT 1
  `, [postId]);
  return result?.rows?.[0] || null;
}

async function upsertCrankScore(postId: number, scores: any) {
  await pgPool.run('blog', `
    INSERT INTO blog.crank_scores
      (post_id, scored_date, crank_total, crank_context, crank_content, crank_chain, crank_creator,
       dia_total, dia_intent, dia_depth, dia_uniqueness,
       geo_total, geo_ai, geo_structure, geo_citation, overall)
    VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    ON CONFLICT (post_id, scored_date) DO UPDATE SET
      crank_total    = EXCLUDED.crank_total,
      crank_context  = EXCLUDED.crank_context,
      crank_content  = EXCLUDED.crank_content,
      crank_chain    = EXCLUDED.crank_chain,
      crank_creator  = EXCLUDED.crank_creator,
      dia_total      = EXCLUDED.dia_total,
      dia_intent     = EXCLUDED.dia_intent,
      dia_depth      = EXCLUDED.dia_depth,
      dia_uniqueness = EXCLUDED.dia_uniqueness,
      geo_total      = EXCLUDED.geo_total,
      geo_ai         = EXCLUDED.geo_ai,
      geo_structure  = EXCLUDED.geo_structure,
      geo_citation   = EXCLUDED.geo_citation,
      overall        = EXCLUDED.overall
  `, [
    postId,
    scores.crank.total, scores.crank.detail.context, scores.crank.detail.content,
    scores.crank.detail.chain, scores.crank.detail.creator,
    scores.dia.total, scores.dia.detail.intent, scores.dia.detail.depth, scores.dia.detail.uniqueness,
    scores.geo.total, scores.geo.detail.ai_friendliness, scores.geo.detail.structure, scores.geo.detail.citation,
    scores.total,
  ]);
}

export interface CrankTrackResult {
  processed: number;
  alerts: Array<{
    postId: number;
    title: string;
    delta: number;
    current: number;
    previous: number;
  }>;
  summary: string;
}

export async function runCrankTracker(daysBack = 14): Promise<CrankTrackResult> {
  await ensureCrankScoresTable();

  const posts = await getRecentPublishedPosts(daysBack);
  const alerts: CrankTrackResult['alerts'] = [];
  let processed = 0;

  for (const post of posts) {
    try {
      const scores = calculateNaverSEOScore(post);
      const prev = await getPreviousScore(post.id);
      await upsertCrankScore(post.id, scores);
      processed++;

      if (prev) {
        const delta = scores.total - prev.overall;
        if (Math.abs(delta) >= SCORE_CHANGE_THRESHOLD) {
          alerts.push({
            postId: post.id,
            title: post.title,
            delta,
            current: scores.total,
            previous: prev.overall,
          });
        }
      }
    } catch (e: any) {
      console.warn(`[크랭크트래커] 포스트 #${post.id} 처리 실패:`, e.message);
    }
  }

  const summary = [
    `처리: ${processed}/${posts.length}건`,
    alerts.length > 0
      ? `변화 감지: ${alerts.length}건 (±${SCORE_CHANGE_THRESHOLD}점 이상)`
      : '점수 변화 없음',
  ].join(' | ');

  return { processed, alerts, summary };
}

export async function formatCrankReport(result: CrankTrackResult): Promise<string> {
  const lines = [
    `📊 [C-Rank 추적] ${result.summary}`,
  ];

  if (result.alerts.length > 0) {
    lines.push('');
    lines.push('📈 점수 변화 감지:');
    for (const a of result.alerts.slice(0, 5)) {
      const icon = a.delta > 0 ? '⬆️' : '⬇️';
      const deltaStr = a.delta > 0 ? `+${a.delta}` : String(a.delta);
      lines.push(`  ${icon} ${a.title.substring(0, 30)} (${a.previous}→${a.current}, ${deltaStr}점)`);
    }
  }

  return lines.join('\n');
}
