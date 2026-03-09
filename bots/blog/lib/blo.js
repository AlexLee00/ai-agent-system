'use strict';

/**
 * blo.js (블로) — 블로그팀 팀장 오케스트레이션
 *
 * 매일 실행되는 메인 흐름:
 *   1. 설정 읽기 (오늘 몇 편?)
 *   2. 카테고리/강의번호 결정
 *   3. 리처 수집 (병렬)
 *   4. 포스/젬스 작성
 *   5. 품질 검증 (실패 시 1회 재작성)
 *   6. 퍼블리셔 파일 생성
 *   7. 텔레그램 리포트
 */

const { getConfig }                                 = require('./daily-config');
const {
  getNextGeneralCategory, advanceGeneralCategory,
  getNextLectureNumber, advanceLectureNumber,
  isSeriesComplete, getLectureTitle,
}                                                   = require('./category-rotation');
const { research }                                  = require('./richer');
const { writeLecturePost }                          = require('./pos-writer');
const { writeGeneralPost }                          = require('./gems-writer');
const { checkQuality }                              = require('./quality-checker');
const { publishToFile }                             = require('./publ');
const pgPool                                        = require('../../../packages/core/lib/pg-pool');
const tg                                            = require('../../../packages/core/lib/telegram-sender');

// ─── 스키마 초기화 ────────────────────────────────────────────────────

async function ensureSchema() {
  try {
    await pgPool.run('blog', 'SELECT 1 FROM blog.daily_config LIMIT 1');
  } catch {
    console.warn('[블로] blog 스키마 미초기화 — 마이그레이션 필요: bots/blog/migrations/001-blog-schema.sql');
  }
}

// ─── 강의 포스팅 ──────────────────────────────────────────────────────

async function runLecturePost(researchData) {
  // 시리즈 완료 체크
  if (await isSeriesComplete()) {
    const msg = '⚠️ [블로그팀] Node.js 120강 완료!\n다음 시리즈를 선택해 주세요.\n추천: Python > TypeScript > React';
    console.log('[블로]', msg);
    try { await tg.send('blog', msg); } catch {}
    return { type: 'lecture', skipped: true, reason: '시리즈 완료' };
  }

  const { number, seriesName } = await getNextLectureNumber();
  const lectureTitle = await getLectureTitle(number, seriesName) || `제${number}강`;

  console.log(`\n[포스] ${number}강: ${lectureTitle}`);

  // 작성
  let post = await writeLecturePost(number, lectureTitle, researchData);
  let quality = checkQuality(post.content, 'lecture');
  console.log(`[품질] ${quality.passed ? '✅' : '❌'} ${post.charCount}자, 이슈 ${quality.issues.length}건`);
  quality.issues.forEach(i => console.log(`  [${i.severity}] ${i.msg}`));

  // 실패 시 1회 재작성
  if (!quality.passed) {
    console.log('[품질] 재작성 시도...');
    const retry        = await writeLecturePost(number, lectureTitle, researchData);
    const retryQuality = checkQuality(retry.content, 'lecture');
    if (retryQuality.passed) {
      post    = retry;
      quality = retryQuality;
      console.log('[품질] ✅ 재작성 통과');
    } else {
      console.log('[품질] ⚠️ 재작성도 미달 — 그대로 저장');
    }
  }

  // 저장
  const published = await publishToFile({
    title:         `[Node.js ${number}강] ${lectureTitle}`,
    content:       post.content,
    category:      'Node.js강의',
    postType:      'lecture',
    lectureNumber: number,
    charCount:     post.charCount,
  });

  await advanceLectureNumber();

  return {
    type:      'lecture',
    number,
    title:     lectureTitle,
    charCount: post.charCount,
    quality:   quality.passed,
    filename:  published.filename,
    postId:    published.postId,
  };
}

// ─── 일반 포스팅 ──────────────────────────────────────────────────────

async function runGeneralPost(researchData) {
  const { category } = await getNextGeneralCategory();
  const needsBook    = category === '도서리뷰';

  console.log(`\n[젬스] 일반 포스팅: ${category}`);

  // 필요 시 리서치 추가 (도서리뷰)
  const data = needsBook ? await research(category, true) : researchData;

  // 작성
  let post = await writeGeneralPost(category, data);
  let quality = checkQuality(post.content, 'general');
  console.log(`[품질] ${quality.passed ? '✅' : '❌'} ${post.charCount}자, 이슈 ${quality.issues.length}건`);
  quality.issues.forEach(i => console.log(`  [${i.severity}] ${i.msg}`));

  // 실패 시 1회 재작성
  if (!quality.passed) {
    console.log('[품질] 재작성 시도...');
    const retry        = await writeGeneralPost(category, data);
    const retryQuality = checkQuality(retry.content, 'general');
    if (retryQuality.passed) {
      post    = retry;
      quality = retryQuality;
      console.log('[품질] ✅ 재작성 통과');
    }
  }

  // 저장
  const published = await publishToFile({
    title:    post.title || `[${category}] 오늘의 포스팅`,
    content:  post.content,
    category,
    postType: 'general',
    charCount: post.charCount,
  });

  await advanceGeneralCategory();

  return {
    type:      'general',
    category,
    title:     post.title || `[${category}]`,
    charCount: post.charCount,
    quality:   quality.passed,
    filename:  published.filename,
    postId:    published.postId,
  };
}

// ─── 메인 ───────────────────────────────────────────────────────────

async function run() {
  console.log('\n📝 [블로] 블로그팀 일간 작업 시작\n');
  await ensureSchema();

  // 1. 설정 읽기
  const config = await getConfig();
  if (!config.active) {
    console.log('[블로] 일시 정지 상태. 종료.');
    return [];
  }
  console.log(`[블로] 오늘 발행: 강의 ${config.lecture_count}편 + 일반 ${config.general_count}편`);

  // 2. 공통 리서치 (강의 + 일반 공유)
  const researchData = await research('general', false);

  const results = [];

  // 3. 강의 포스팅
  for (let i = 0; i < (config.lecture_count || 0); i++) {
    try {
      const r = await runLecturePost(researchData);
      results.push(r);
    } catch (e) {
      console.error('[블로] 강의 포스팅 실패:', e.message);
      results.push({ type: 'lecture', error: e.message });
    }
  }

  // 4. 일반 포스팅
  for (let i = 0; i < (config.general_count || 0); i++) {
    try {
      const r = await runGeneralPost(researchData);
      results.push(r);
    } catch (e) {
      console.error('[블로] 일반 포스팅 실패:', e.message);
      results.push({ type: 'general', error: e.message });
    }
  }

  // 5. 텔레그램 리포트
  const reportLines = [
    '📝 [블로그팀] 일간 작업 완료',
    '',
    ...results.map(r => {
      if (r.error)    return `❌ ${r.type}: ${r.error.slice(0, 60)}`;
      if (r.skipped)  return `⏭ ${r.type}: ${r.reason}`;
      const label = r.type === 'lecture' ? `강의 ${r.number}강` : `일반[${r.category}]`;
      return `${r.quality ? '✅' : '⚠️'} ${label}: ${r.title?.slice(0, 30)} (${r.charCount}자)`;
    }),
    '',
    `📁 파일 위치: bots/blog/output/`,
    `📅 예약 발행: 내일 오전 07:00`,
  ];

  try {
    await tg.send('blog', reportLines.join('\n'));
  } catch (e) {
    console.warn('[블로] 텔레그램 발송 실패:', e.message);
  }

  console.log('\n📝 [블로] 일간 작업 완료\n');
  return results;
}

module.exports = { run };
