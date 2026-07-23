// @ts-nocheck
'use strict';

/**
 * master-edit-analyzer.ts — 마스터 발행 diff 분석 + 스타일 학습
 *
 * 마스터 요청 핵심:
 *   "마스터가 발행 + 1일에 등록되면 초안과 등록된 내용을 학습!"
 *
 * 흐름:
 *   Phase 1: 발행 검출 (naver-url-backfill + RSS 매칭)
 *   Phase 2: Diff 분석 (초안 vs 발행본)
 *   Phase 3: 스타일 패턴 학습 (LLM + DB 누적)
 *   Phase 4: 다음 작성 시 system_prompt에 자동 반영
 */

const path = require('path');
const env  = require('../../../packages/core/lib/env');
const pgPool = require('../../../packages/core/lib/pg-pool');
const kst    = require('../../../packages/core/lib/kst');
const { callHubLlm } = require('../../../packages/core/lib/hub-client');

const BLOG_ROOT = path.join(env.PROJECT_ROOT, 'bots', 'blog');

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

function stripHtmlToText(html) {
  return decodeHtmlEntities(String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/section|\/article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '));
}

function normalizeAnalyzerText(value) {
  return String(value || '')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function normalizeAnalyzerTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function buildOriginalDraftContent(post) {
  const content = normalizeAnalyzerText(post && post.content);
  if (content) return content;
  return normalizeAnalyzerText(stripHtmlToText(post && post.html_content));
}

async function ensureMasterEditAnalysisTable(pool = pgPool) {
  const rows = await pool.query('blog', "SELECT to_regclass('blog.master_edit_analysis') AS regclass");
  return Boolean(rows?.[0]?.regclass);
}

// ─────────────────────────── Phase 1: 발행 검출 ──────────────────────────────

/**
 * 어제 또는 최근 N일 내 작성 초안 중 네이버에 실제 발행된 포스팅을 탐색
 * naver-url-backfill.ts의 backfillNaverPublishedUrls 결과를 활용
 */
async function detectPublishedDrafts(options = {}) {
  const days = options.days || 2;
  const pool = options.pgPool || pgPool;
  try {
    const cutoff = kst.daysAgoStr(days);
    const schemaReady = await ensureMasterEditAnalysisTable(pool).catch((err) => {
      console.log('[master-edit-analyzer] 분석 테이블 준비 실패:', err.message);
      return false;
    });
    if (!schemaReady) return [];
    const rows = await pool.query(
      'blog',
      `SELECT
         p.id,
         p.title,
         p.content,
         p.html_content,
         p.category,
         p.post_type AS type,
         p.naver_url,
         p.status,
         p.publish_date,
         fcc.final_title,
         fcc.final_content_text,
         fcc.checked_at AS final_checked_at
       FROM blog.posts p
       JOIN blog.final_content_checks fcc ON fcc.post_id = p.id
       WHERE p.status = 'published'
         AND COALESCE(p.naver_url, '') <> ''
         AND fcc.changed = TRUE
         AND fcc.status = 'changed'
         AND COALESCE(fcc.final_content_text, '') <> ''
         AND DATE(COALESCE(fcc.checked_at, p.publish_date::timestamptz)) >= $1
         AND NOT EXISTS (
           SELECT 1
           FROM blog.master_edit_analysis mea
           WHERE mea.post_id = p.id
             AND mea.analyzed_at >= fcc.checked_at
         )
       ORDER BY COALESCE(fcc.checked_at, p.publish_date::timestamptz) DESC, p.id DESC
       LIMIT 20`,
      [cutoff],
    );
    return rows || [];
  } catch (err) {
    console.log('[master-edit-analyzer] 발행 초안 탐색 실패:', err.message);
    return [];
  }
}

// ─────────────────────────── Phase 2: Diff 분석 ──────────────────────────────

/**
 * 단어 토큰 기반 추가/삭제 diff 계산
 */
function computeWordDiff(original, modified) {
  const tokenize = (text) =>
    String(text || '')
      .replace(/<[^>]+>/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 0);

  const origTokens = tokenize(original);
  const modTokens  = tokenize(modified);

  const origSet = new Set(origTokens);
  const modSet  = new Set(modTokens);

  const added   = modTokens.filter((w) => !origSet.has(w));
  const removed = origTokens.filter((w) => !modSet.has(w));

  const addedRatio   = origTokens.length > 0 ? added.length / origTokens.length : 0;
  const removedRatio = origTokens.length > 0 ? removed.length / origTokens.length : 0;

  return {
    added_count: added.length,
    removed_count: removed.length,
    added_ratio: Math.round(addedRatio * 100) / 100,
    removed_ratio: Math.round(removedRatio * 100) / 100,
    added_sample: added.slice(0, 20),
    removed_sample: removed.slice(0, 20),
    change_rate: Math.round((added.length + removed.length) / Math.max(origTokens.length, 1) * 100) / 100,
  };
}

/**
 * 제목 diff — 단어 겹침 계산
 */
function computeTitleDiff(originalTitle, modifiedTitle) {
  const normalize = (t) =>
    String(t || '')
      .replace(/^\[[^\]]+\]\s*/, '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 2);

  const orig = new Set(normalize(originalTitle));
  const mod  = new Set(normalize(modifiedTitle));

  const added   = [...mod].filter((w) => !orig.has(w));
  const removed = [...orig].filter((w) => !mod.has(w));
  const common  = [...orig].filter((w) => mod.has(w));

  const similarity = (orig.size + mod.size) > 0
    ? common.length * 2 / (orig.size + mod.size)
    : 1;

  return {
    original: originalTitle,
    modified: modifiedTitle,
    changed: similarity < 0.8,
    similarity: Math.round(similarity * 100) / 100,
    added_words: added,
    removed_words: removed,
  };
}

/**
 * LLM을 통한 변경 패턴 분류
 */
async function classifyEditPattern(originalTitle, modifiedTitle, wordDiff) {
  try {
    const prompt = `마스터 편집 패턴 분류

원본 제목: ${originalTitle}
수정 제목: ${modifiedTitle}
추가 단어 (샘플): ${wordDiff.added_sample.slice(0, 10).join(', ')}
삭제 단어 (샘플): ${wordDiff.removed_sample.slice(0, 10).join(', ')}
변경률: ${(wordDiff.change_rate * 100).toFixed(0)}%

마스터의 편집 패턴을 분류하고 JSON만 출력하라:
{
  "primary_type": "tone|structure|keyword|length|seo|persona",
  "sub_types": ["type1", "type2"],
  "pattern_summary": "(한 문장: 마스터는 X를 Y로 변경함)",
  "preference_rule": "(추출된 선호 규칙: 마스터는 항상/주로 X를 선호함)"
}`;

    const result = await callHubLlm({
      callerTeam: 'blog',
      agent: 'master-edit-analyzer',
      selectorKey: 'blog.master.analyze',
      systemPrompt: '편집 패턴 분석가. JSON만 출력.',
      prompt,
      maxTokens: 200,
    });

    const text = String(result?.content || result?.text || '');
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch {
    // fallback
  }

  return {
    primary_type: 'unknown',
    sub_types: [],
    pattern_summary: '분류 실패',
    preference_rule: '',
  };
}

// ─────────────────────────── Phase 3: DB 저장 ────────────────────────────────

/**
 * Diff 분석 결과를 DB에 저장
 * 테이블: blog.master_edit_analysis (없으면 자동 생성 시도)
 */
async function saveDiffAnalysis(postId, titleDiff, wordDiff, editPattern, options = {}) {
  const pool = options.pgPool || pgPool;
  try {
    if (!await ensureMasterEditAnalysisTable(pool)) return false;

    await pool.query(
      'blog',
      `INSERT INTO blog.master_edit_analysis
         (post_id, title_changed, title_sim, added_ratio, removed_ratio, change_rate,
          primary_type, sub_types, pattern_summary, preference_rule, raw_diff)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        postId,
        titleDiff.changed,
        titleDiff.similarity,
        wordDiff.added_ratio,
        wordDiff.removed_ratio,
        wordDiff.change_rate,
        editPattern.primary_type,
        editPattern.sub_types || [],
        editPattern.pattern_summary,
        editPattern.preference_rule,
        JSON.stringify({ titleDiff, wordDiff }),
      ],
    );

    // posts 테이블에 analyzed 플래그 설정
    await pool.query(
      'blog',
      `UPDATE blog.posts SET analyzed_master_edit = TRUE WHERE id = $1`,
      [postId],
    ).catch(() => {});

    return true;
  } catch (err) {
    console.log('[master-edit-analyzer] DB 저장 실패:', err.message);
    return false;
  }
}

// ─────────────────────────── Phase 4: 스타일 프로파일 ────────────────────────

/**
 * 최근 N건 분석 결과를 집계하여 마스터 스타일 프로파일 생성
 */
async function buildMasterStyleProfile(options = {}) {
  const limit = options.limit || 100;
  const postType = String(options.postType || '').trim() || null;
  const category = String(options.category || '').trim() || null;
  const pool = options.pgPool || pgPool;
  try {
    if (!await ensureMasterEditAnalysisTable(pool)) {
      return { rules: [], summary: '분석 테이블 미적용', sample_count: 0 };
    }
    const rows = await pool.query(
      'blog',
      `SELECT mea.primary_type, mea.preference_rule, mea.title_changed, mea.change_rate
       FROM blog.master_edit_analysis mea
       JOIN blog.posts p ON p.id = mea.post_id
       WHERE ($1::text IS NULL OR p.post_type = $1)
         AND ($2::text IS NULL OR p.category = $2)
       ORDER BY mea.analyzed_at DESC
       LIMIT $3`,
      [postType, category, limit],
    );

    if (!rows || rows.length === 0) {
      return { rules: [], summary: '분석 데이터 없음', sample_count: 0 };
    }

    // 타입별 집계
    const typeCount = {};
    const rules = [];
    for (const row of rows) {
      typeCount[row.primary_type] = (typeCount[row.primary_type] || 0) + 1;
      if (row.preference_rule && !rules.includes(row.preference_rule)) {
        rules.push(row.preference_rule);
      }
    }

    const topTypes = Object.entries(typeCount)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([type, count]) => `${type}(${count}회)`);

    const avgChangeRate = rows.reduce((sum, r) => sum + Number(r.change_rate || 0), 0) / rows.length;
    const titleChangeRate = rows.filter((r) => r.title_changed).length / rows.length;

    const summary = [
      `주요 수정 유형: ${topTypes.join(', ')}`,
      `평균 변경률: ${(avgChangeRate * 100).toFixed(1)}%`,
      `제목 수정 빈도: ${(titleChangeRate * 100).toFixed(0)}%`,
    ].join(' | ');

    return {
      rules: rules.slice(0, 10),
      topTypes,
      avgChangeRate,
      titleChangeRate,
      summary,
      sample_count: rows.length,
      post_type: postType,
      category,
    };
  } catch (err) {
    console.log('[master-edit-analyzer] 스타일 프로파일 빌드 실패:', err.message);
    return { rules: [], summary: '조회 실패', sample_count: 0 };
  }
}

/**
 * 마스터 스타일 프로파일을 작성 system_prompt 형태로 변환
 */
function formatStyleProfileForPrompt(profile) {
  if (!profile || profile.sample_count === 0) return '';

  const lines = [
    '=== 마스터 스타일 학습 가이드 (최근 편집 패턴 기반) ===',
    `분석 건수: ${profile.sample_count}건`,
    `${profile.summary}`,
  ];

  if (profile.rules && profile.rules.length > 0) {
    lines.push('');
    lines.push('학습된 선호 규칙:');
    for (const rule of profile.rules.slice(0, 5)) {
      lines.push(`  - ${rule}`);
    }
  }

  lines.push('=== 위 가이드를 반영하여 초안 작성 ===');
  return lines.join('\n');
}

// ─────────────────────────── 메인: 일일 분석 실행 ─────────────────────────────

/**
 * 일일 마스터 편집 분석 실행 (launchd 또는 blo.ts 호출)
 * 발행된 포스팅을 탐색 → diff 분석 → DB 저장
 */
async function runDailyMasterEditAnalysis(options = {}) {
  console.log('[master-edit-analyzer] 일일 편집 분석 시작');

  const publishedPosts = await detectPublishedDrafts(options);
  if (publishedPosts.length === 0) {
    console.log('[master-edit-analyzer] 분석 대상 없음');
    return { analyzed: 0, skipped: 0 };
  }

  let analyzed = 0;
  let skipped  = 0;

  for (const post of publishedPosts) {
    try {
      const originalTitle = normalizeAnalyzerTitle(post.title);
      const modifiedTitle = normalizeAnalyzerTitle(post.final_title) || originalTitle;
      const originalContent = buildOriginalDraftContent(post);
      const modifiedContent = normalizeAnalyzerText(post.final_content_text);
      if (!originalContent || !modifiedContent) {
        skipped++;
        continue;
      }
      const titleDiff  = computeTitleDiff(originalTitle, modifiedTitle);
      const wordDiff   = computeWordDiff(originalContent, modifiedContent);
      const classifier = options.classifyEditPattern || classifyEditPattern;
      const editPattern = await classifier(originalTitle, modifiedTitle, wordDiff);

      await saveDiffAnalysis(post.id, titleDiff, wordDiff, editPattern, options);
      analyzed++;
    } catch {
      skipped++;
    }
  }

  console.log(`[master-edit-analyzer] 분석 완료: ${analyzed}건, 스킵: ${skipped}건`);
  return { analyzed, skipped };
}

module.exports = {
  ensureMasterEditAnalysisTable,
  detectPublishedDrafts,
  computeWordDiff,
  computeTitleDiff,
  classifyEditPattern,
  saveDiffAnalysis,
  buildMasterStyleProfile,
  formatStyleProfileForPrompt,
  runDailyMasterEditAnalysis,
  _testOnly: {
    decodeHtmlEntities,
    stripHtmlToText,
    normalizeAnalyzerText,
    normalizeAnalyzerTitle,
    buildOriginalDraftContent
  },
};
