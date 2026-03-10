'use strict';

/**
 * blo.js (블로) — 블로그팀 팀장 오케스트레이션
 *
 * 매일 실행되는 메인 흐름:
 *   1. 설정 읽기 (오늘 몇 편?)
 *   2. RAG — 과거 포스팅 참조 + 인기 패턴 검색
 *   3. 리처 수집 (IT뉴스/Node.js/날씨 + RAG 실전 사례/관련 포스팅)
 *   4. 포스/젬스 작성 (MessageEnvelope 구조화, trace_id 추적)
 *   5. 품질 검증 (실패 시 1회 재작성)
 *   6. 퍼블리셔 파일 생성 + RAG 저장
 *   7. State Bus 이벤트 발행 (덱스터 감시용)
 *   8. 텔레그램 리포트 + AI 리라이팅 가이드 (mode-guard)
 */

const maestro                                       = require('./maestro');
const { generatePostImages }                        = require('./img-gen');
const { createInstaContent }                        = require('./star');
const { getConfig }                                 = require('./daily-config');
const {
  advanceGeneralCategory,
  advanceLectureNumber,
  isSeriesComplete,
  getLectureTitle,
  getNextLectureNumber,
}                                                   = require('./category-rotation');
const {
  getTodayContext,
  updateScheduleStatus,
}                                                   = require('./schedule');
const { researchBook }                              = require('./book-research');
const richer                                        = require('./richer');
const { writeLecturePost, writeLecturePostChunked } = require('./pos-writer');
const { writeGeneralPost, writeGeneralPostChunked } = require('./gems-writer');
const { checkQuality }                              = require('./quality-checker');
const { publishToFile }                             = require('./publ');
const pgPool                                        = require('../../../packages/core/lib/pg-pool');
const tg                                            = require('../../../packages/core/lib/telegram-sender');
const rag                                           = require('../../../packages/core/lib/rag');
const { createMessage }                             = require('../../../packages/core/lib/message-envelope');
const { startTrace, withTrace, getTraceId }         = require('../../../packages/core/lib/trace');
const { runIfOps }                                  = require('../../../packages/core/lib/mode-guard');
const stateBus                                      = require('../../../bots/reservation/lib/state-bus');

// ─── 스키마 초기화 ────────────────────────────────────────────────────

async function ensureSchema() {
  try {
    await pgPool.run('blog', 'SELECT 1 FROM blog.daily_config LIMIT 1');
  } catch {
    console.warn('[블로] blog 스키마 미초기화 — 마이그레이션 필요: bots/blog/migrations/001-blog-schema.sql');
  }
}

// ─── State Bus 이벤트 발행 ────────────────────────────────────────────

async function _emitEvent(eventType, detail) {
  try {
    await stateBus.emitEvent('blog-blo', 'claude-lead', eventType, detail);
  } catch (e) {
    console.warn(`[블로] State Bus 이벤트 실패 (${eventType}):`, e.message);
  }
}

// ─── RAG — 과거 포스팅 + 인기 패턴 ──────────────────────────────────

async function searchPastPosts(topic) {
  try {
    await rag.initSchema();
    const hits = await rag.search('blog', topic, { limit: 3, threshold: 0.6 });
    return hits || [];
  } catch { return []; }
}

async function getPopularPatterns() {
  try {
    const hits = await rag.search('blog', '인기패턴 popular_pattern', { limit: 5 });
    if (!hits?.length) return null;
    return { topPosts: hits.map(h => h.content?.slice(0, 100)) };
  } catch { return null; }
}

// ─── 리라이팅 가이드 생성 ─────────────────────────────────────────────

function _buildRewriteGuide(aiRisk) {
  if (!aiRisk || aiRisk.riskLevel === 'low') {
    return '✅ AI 탐지 리스크 낮음 — 가벼운 수정만으로 충분합니다.';
  }
  return [
    `⚠️ AI 탐지 리스크: ${aiRisk.riskLevel.toUpperCase()} (${aiRisk.riskScore}점)`,
    '📝 리라이팅 가이드:',
    '  1. 오늘 커피랑도서관에서 있었던 에피소드 1개 추가',
    '  2. "솔직히", "제가 느끼기에" 등 구어체 2~3곳 삽입',
    '  3. 감정 표현 1~2곳 추가 ("정말 놀랐다", "뿌듯했다")',
    '  4. 직접 촬영한 사진 1장 추가',
    '  5. ★ ai-agent-system 개발 에피소드 1개 삽입',
  ].join('\n');
}

// ─── 강의 포스팅 ──────────────────────────────────────────────────────

async function runLecturePost(researchData, traceCtx, preloaded = {}, scheduleId = null) {
  if (await isSeriesComplete()) {
    const msg = '⚠️ [블로그팀] Node.js 120강 완료!\n다음 시리즈를 선택해 주세요.\n추천: Python > TypeScript > React';
    console.log('[블로]', msg);
    await runIfOps('blog-tg', () => tg.send('blog', msg), () => console.log('[DEV] 텔레그램 생략'));
    return { type: 'lecture', skipped: true, reason: '시리즈 완료' };
  }

  // 마에스트로 변형 — preloaded에서 우선 사용, 없으면 빈 객체
  const sectionVariation = preloaded.sectionVariation || {};

  const { number, seriesName } = preloaded.number
    ? preloaded
    : await getNextLectureNumber();
  const lectureTitle = preloaded.lectureTitle
    || (await getLectureTitle(number, seriesName)) || `제${number}강`;

  console.log(`\n[포스] ${number}강: ${lectureTitle}`);

  // MessageEnvelope — 블로 → 포스 작성 요청 (로깅용)
  const writeReq = createMessage('task_request', 'blog-blo', 'blog-pos', {
    lectureNumber: number,
    lectureTitle,
    traceId: traceCtx.trace_id,
  });
  console.log(`[블로] MessageEnvelope → 포스 (${writeReq.message_id.slice(0, 8)})`);

  // 과거 유사 포스팅 중복 체크
  const pastPosts = await searchPastPosts(lectureTitle);
  if (pastPosts.length > 0) {
    console.log(`[블로] 유사 과거 포스팅 ${pastPosts.length}건 발견 — 차별화 데이터 포함`);
    researchData.pastPosts = pastPosts;
  }

  // BLOG_LLM_MODEL=gemini → 분할생성 (무료), 기본=gpt4o
  const useChunked = (process.env.BLOG_LLM_MODEL === 'gemini');

  // 작성
  return await withTrace(traceCtx, async () => {
    let post    = useChunked
      ? await writeLecturePostChunked(number, lectureTitle, researchData, sectionVariation)
      : await writeLecturePost(number, lectureTitle, researchData, sectionVariation);
    let quality = checkQuality(post.content, 'lecture');
    console.log(`[품질] ${quality.passed ? '✅' : '❌'} ${post.charCount}자, AI리스크: ${quality.aiRisk?.riskLevel || '-'}, 이슈 ${quality.issues.length}건`);
    quality.issues.forEach(i => console.log(`  [${i.severity}] ${i.msg}`));

    if (!quality.passed) {
      console.log('[품질] 재작성 시도...');
      const retry        = useChunked
        ? await writeLecturePostChunked(number, lectureTitle, researchData, sectionVariation)
        : await writeLecturePost(number, lectureTitle, researchData, sectionVariation);
      const retryQuality = checkQuality(retry.content, 'lecture');
      if (retryQuality.passed) {
        post    = retry;
        quality = retryQuality;
        console.log('[품질] ✅ 재작성 통과');
      } else {
        console.log('[품질] ⚠️ 재작성도 미달 — 그대로 저장');
      }
    }

    const postTitle = `[Node.js ${number}강] ${lectureTitle}`;
    const published = await publishToFile({
      title:         postTitle,
      content:       post.content,
      category:      'Node.js강의',
      postType:      'lecture',
      lectureNumber: number,
      charCount:     post.charCount,
    });

    // 스케줄 상태 업데이트
    if (scheduleId) {
      await updateScheduleStatus(scheduleId, 'published', published.postId);
    }

    await advanceLectureNumber();

    // ★ 강의 인스타 콘텐츠 (BLOG_INSTA_ENABLED=true 시)
    let instaContent = null;
    if (process.env.BLOG_INSTA_ENABLED === 'true') {
      instaContent = await createInstaContent(post.content, postTitle, 'Node.js강의').catch(e => {
        console.warn('[소셜] 강의 인스타 생성 실패 (무시):', e.message); return null;
      });
      if (instaContent) {
        console.log(`[소셜] 강의 인스타 완료: 카드 ${instaContent.cards?.length}장 + 해시태그 ${instaContent.hashtags?.length}개`);
      }
    }

    await _emitEvent('post_completed', {
      type: 'lecture', number, title: lectureTitle, charCount: post.charCount,
      traceId: traceCtx.trace_id,
    });

    return {
      type:         'lecture',
      number,
      title:        lectureTitle,
      instaContent: instaContent || null,
      charCount: post.charCount,
      quality:   quality.passed,
      aiRisk:    quality.aiRisk,
      filename:  published.filename,
      postId:    published.postId,
    };
  });
}

// ─── 일반 포스팅 ──────────────────────────────────────────────────────

async function runGeneralPost(researchData, traceCtx, preloaded = {}, scheduleId = null) {
  const { category } = preloaded.category ? preloaded : { category: '자기계발' };
  // 마에스트로 변형 — preloaded에서 우선 사용, 없으면 빈 객체
  const sectionVariation = preloaded.sectionVariation || {};
  const needsBook    = category === '도서리뷰';

  console.log(`\n[젬스] 일반 포스팅: ${category}`);

  // MessageEnvelope — 블로 → 젬스 작성 요청
  const writeReq = createMessage('task_request', 'blog-blo', 'blog-gems', {
    category,
    traceId: traceCtx.trace_id,
  });
  console.log(`[블로] MessageEnvelope → 젬스 (${writeReq.message_id.slice(0, 8)})`);

  // 도서리뷰: book-research.js로 실제 도서 정보 수집 (스케줄 도서 정보 우선)
  let data = researchData;
  if (needsBook) {
    data = { ...researchData };
    const scheduledBook = preloaded.bookInfo;
    if (scheduledBook?.book_title) {
      // 스케줄에 이미 도서 정보 있으면 그대로 사용
      data.book_info = scheduledBook;
      console.log(`[젬스] 스케줄 도서 정보 사용: ${scheduledBook.book_title}`);
    } else {
      // 없으면 book-research.js로 수집
      try {
        const book = await researchBook();
        data.book_info = book;
        // 스케줄에 도서 정보 저장 (다음 실행 시 재사용)
        if (scheduleId && book?.title) {
          const { updateBookInfo } = require('./schedule');
          await updateBookInfo(scheduleId, {
            book_title:  book.title,
            book_author: book.author,
            book_isbn:   book.isbn,
          });
        }
      } catch (e) {
        console.warn('[젬스] 도서 정보 수집 실패 (기본 진행):', e.message);
      }
    }
  }

  // BLOG_LLM_MODEL=gemini → 분할생성 (무료), 기본=gpt4o
  const useChunked = (process.env.BLOG_LLM_MODEL === 'gemini');

  return await withTrace(traceCtx, async () => {
    let post    = useChunked
      ? await writeGeneralPostChunked(category, data, sectionVariation)
      : await writeGeneralPost(category, data, sectionVariation);
    let quality = checkQuality(post.content, 'general');
    console.log(`[품질] ${quality.passed ? '✅' : '❌'} ${post.charCount}자, AI리스크: ${quality.aiRisk?.riskLevel || '-'}, 이슈 ${quality.issues.length}건`);
    quality.issues.forEach(i => console.log(`  [${i.severity}] ${i.msg}`));

    if (!quality.passed) {
      console.log('[품질] 재작성 시도...');
      const retry        = useChunked
        ? await writeGeneralPostChunked(category, data, sectionVariation)
        : await writeGeneralPost(category, data, sectionVariation);
      const retryQuality = checkQuality(retry.content, 'general');
      if (retryQuality.passed) {
        post    = retry;
        quality = retryQuality;
        console.log('[품질] ✅ 재작성 통과');
      }
    }

    const genTitle = post.title || `[${category}] 오늘의 포스팅`;
    const images = await generatePostImages({ title: genTitle, postType: 'general', category }).catch(e => {
      console.warn('[이미지] 생성 실패 (일반):', e.message); return null;
    });

    // ★ 소셜(SOCIAL) — 인스타 크로스 포스팅 (generalVariations.includeInsta 기반)
    let instaContent = null;
    if (process.env.BLOG_INSTA_ENABLED === 'true') {
      instaContent = await createInstaContent(post.content, genTitle, category).catch(e => {
        console.warn('[소셜] 인스타 생성 실패 (무시):', e.message); return null;
      });
      if (instaContent) {
        console.log(`[소셜] 인스타 완료: 카드 ${instaContent.cards?.length}장 + 해시태그 ${instaContent.hashtags?.length}개`);
      }
    }

    const published = await publishToFile({
      title:    genTitle,
      content:  post.content,
      category,
      postType: 'general',
      charCount: post.charCount,
      images,
    });

    // 스케줄 상태 업데이트
    if (scheduleId) {
      await updateScheduleStatus(scheduleId, 'published', published.postId);
    }

    await advanceGeneralCategory();

    await _emitEvent('post_completed', {
      type: 'general', category, title: post.title, charCount: post.charCount,
      traceId: traceCtx.trace_id,
    });

    return {
      type:         'general',
      category,
      title:        post.title || `[${category}]`,
      charCount:    post.charCount,
      quality:      quality.passed,
      aiRisk:       quality.aiRisk,
      filename:     published.filename,
      postId:       published.postId,
      instaContent: instaContent || null,
    };
  });
}

// ─── 메인 ───────────────────────────────────────────────────────────

async function run() {
  console.log('\n📝 [블로] 블로그팀 일간 작업 시작\n');
  await ensureSchema();

  // trace 시작
  const traceCtx = startTrace({ bot: 'blog-blo', action: 'daily_run' });
  console.log(`[블로] trace_id: ${traceCtx.trace_id}`);

  // 1. 설정 읽기
  const config = await getConfig();
  if (!config.active) {
    console.log('[블로] 일시 정지 상태. 종료.');
    return [];
  }
  console.log(`[블로] 오늘 발행: 강의 ${config.lecture_count}편 + 일반 ${config.general_count}편`);

  // State Bus — 일간 작업 시작 이벤트
  await _emitEvent('daily_start', {
    lecture_count: config.lecture_count,
    general_count: config.general_count,
    traceId: traceCtx.trace_id,
  });

  // 2. 마에스트로: 오늘의 변형 결정 (maestro 실패 시 빈 객체로 폴백)
  let lectureVariations = {};
  let generalVariations = {};
  try {
    lectureVariations = maestro.buildDynamicVariation('lecture', []);
    generalVariations = maestro.buildDynamicVariation('general', []);
    console.log(`[마에스트로] 강의 변형: ${lectureVariations.greetingStyle} / 일반 변형: ${generalVariations.greetingStyle}`);
  } catch (e) {
    console.warn('[블로] 마에스트로 변형 결정 실패 (기본값 사용):', e.message);
  }

  // 3. 리서치 수집 + RAG 실전 사례 + 관련 포스팅 + 인기 패턴
  const researchData    = await richer.research('general', false);
  const popularPatterns = await getPopularPatterns();
  if (popularPatterns) researchData.popularPatterns = popularPatterns;

  // 4. 스케줄 기반으로 오늘 작성 목록 결정 (publish_schedule 우선, 없으면 자동 생성)
  const { lectureCtx, generalCtx, lectureSchedule, generalSchedule } = await getTodayContext();
  console.log(`[블로] 스케줄 — 강의: ${lectureCtx ? `${lectureCtx.number}강` : '없음'} / 일반: ${generalCtx?.category || '없음'}`);

  const results = [];

  // 5. 강의 포스팅
  if (lectureCtx && config.lecture_count > 0) {
    try {
      if (await isSeriesComplete()) {
        results.push({ type: 'lecture', skipped: true, reason: '시리즈 완료' });
      } else {
        const { number, seriesName, lectureTitle } = lectureCtx;
        const [realExperiences, relatedPosts] = await Promise.all([
          richer.searchRealExperiences(lectureTitle, 'lecture'),
          richer.searchRelatedPosts(lectureTitle, number),
        ]);
        researchData.realExperiences = realExperiences;
        researchData.relatedPosts    = relatedPosts;

        // 스케줄 상태 → writing
        if (lectureSchedule?.id) await updateScheduleStatus(lectureSchedule.id, 'writing');

        const r = await runLecturePost(researchData, traceCtx, {
          number, seriesName, lectureTitle,
          sectionVariation: lectureVariations,
        }, lectureSchedule?.id);
        results.push(r);
      }
    } catch (e) {
      console.error('[블로] 강의 포스팅 실패:', e.message);
      results.push({ type: 'lecture', error: e.message });
      await _emitEvent('post_failed', { type: 'lecture', error: e.message, traceId: traceCtx.trace_id });
    }
  }

  // 6. 일반 포스팅
  if (generalCtx && config.general_count > 0) {
    try {
      const { category, scheduleId, bookInfo } = generalCtx;
      const [realExperiences, relatedPosts] = await Promise.all([
        richer.searchRealExperiences(category, 'general'),
        richer.searchRelatedPosts(category),
      ]);
      researchData.realExperiences = realExperiences;
      researchData.relatedPosts    = relatedPosts;

      // 스케줄 상태 → writing
      if (scheduleId) await updateScheduleStatus(scheduleId, 'writing');

      const r = await runGeneralPost(researchData, traceCtx, {
        category,
        bookInfo,
        sectionVariation: generalVariations,
      }, scheduleId);
      results.push(r);
    } catch (e) {
      console.error('[블로] 일반 포스팅 실패:', e.message);
      results.push({ type: 'general', error: e.message });
      await _emitEvent('post_failed', { type: 'general', error: e.message, traceId: traceCtx.trace_id });
    }
  }

  // 6. 텔레그램 리포트 (mode-guard 적용)
  const hasErrors = results.some(r => r.error);
  const reportLines = [
    '📝 [블로그팀] 일간 작업 완료',
    `🔖 trace: ${traceCtx.trace_id.slice(0, 8)}`,
    '',
    ...results.map(r => {
      if (r.error)   return `❌ ${r.type}: ${r.error.slice(0, 60)}`;
      if (r.skipped) return `⏭ ${r.type}: ${r.reason}`;
      const label = r.type === 'lecture' ? `강의 ${r.number}강` : `일반[${r.category}]`;
      return `${r.quality ? '✅' : '⚠️'} ${label}: ${r.title?.slice(0, 30)} (${r.charCount}자)`;
    }),
    '',
    // 리라이팅 가이드 (AI 탐지 리스크 기준)
    ...results.filter(r => !r.error && !r.skipped).map(r =>
      `${r.type === 'lecture' ? `[${r.number}강]` : `[${r.category}]`} ${_buildRewriteGuide(r.aiRisk)}`
    ),
    '',
    `📁 파일 위치: bots/blog/output/`,
    `📅 예약 발행: 내일 오전 07:00`,
  ];

  await runIfOps('blog-tg',
    () => tg.send('blog', reportLines.join('\n')),
    () => console.log('[DEV] 텔레그램 생략\n' + reportLines.join('\n'))
  ).catch(e => console.warn('[블로] 텔레그램 발송 실패:', e.message));

  // 에러 있으면 system 토픽으로도 발송
  if (hasErrors) {
    const errMsg = `⚠️ [블로팀] 포스팅 실패 발생 — trace: ${traceCtx.trace_id.slice(0, 8)}`;
    await runIfOps('blog-tg-err',
      () => tg.send('claude', errMsg),
      () => {}
    ).catch(() => {});
  }

  console.log('\n📝 [블로] 일간 작업 완료\n');
  return results;
}

module.exports = { run };
