// @ts-nocheck
'use strict';

/**
 * blo.js (블로) — 블로그팀 팀장 오케스트레이션
 *
 * 매일 실행되는 메인 흐름:
 *   1. 설정 읽기 (오늘 몇 편?)
 *   2. RAG — 과거 포스팅 참조 + 인기 패턴 검색
 *   3. 리처 수집 (IT뉴스/Node.js/날씨 + RAG 실전 사례/관련 포스팅)
 *   4. 포스/젬스 작성 (MessageEnvelope 구조화, trace_id 추적)
 *   5. 품질 검증 (실패 시 초안 보정 1회)
 *   6. 퍼블리셔 파일 생성 + RAG 저장
 *   7. State Bus 이벤트 발행 (덱스터 감시용)
 *   8. 텔레그램 리포트 + AI 리라이팅 가이드 (mode-guard)
 */
const path                                          = require('path');
const env                                           = require('../../../packages/core/lib/env');
const maestro                                       = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/maestro.js'));
const { generatePostImages }                        = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/img-gen.js'));
const { createInstaContent }                        = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/star.js'));
const { getConfig }                                 = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/daily-config.js'));
const {
  GENERAL_CATEGORIES,
  advanceGeneralCategory,
  getNextGeneralCategory,
  advanceLectureNumber,
  isSeriesComplete,
  getLectureTitle,
  getNextLectureNumber,
}                                                   = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/category-rotation.js'));
const {
  getTodayContext,
  updateScheduleStatus,
  updateScheduleCategory,
}                                                   = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/schedule.js'));
const { getBlogCompetitionRuntimeConfig }           = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/runtime-config.js'));
const { blog: blogSkills }                          = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/skills/index.js'));
const {
  dailyCurriculumCheck,
  transitionSeries,
}                                                   = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/curriculum-planner.js'));
const richer                                        = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/richer.js'));
const { collectAllResearch }                        = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/parallel-collector.js'));
const { getRecentPosts, selectAndValidateTopic }    = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/topic-selector.js'));
const {
  writeLecturePost,
  writeLecturePostChunked,
  repairLecturePostDraft,
}                                                   = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/pos-writer.js'));
const {
  writeGeneralPost,
  writeGeneralPostChunked,
  repairGeneralPostDraft,
}                                                   = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/gems-writer.js'));
const { checkQualityEnhanced }                      = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/quality-checker.js'));
const { publishToFile, recordPerformance }          = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/publ.js'));
const pgPool                                        = require('../../../packages/core/lib/pg-pool');
const rag                                           = require('../../../packages/core/lib/rag-safe');
const hiringContract                                = require('../../../packages/core/lib/hiring-contract');
const { createMessage }                             = require('../../../packages/core/lib/message-envelope');
const { startTrace, withTrace, getTraceId }         = require('../../../packages/core/lib/trace');
const { runIfOps }                                  = require('../../../packages/core/lib/mode-guard');
const { postAlarm }                                 = require('../../../packages/core/lib/openclaw-client');
const {
  buildReportEvent,
  renderReportEvent,
  buildNoticeEvent,
  renderNoticeEvent,
}                                                   = require('../../../packages/core/lib/reporting-hub');
const stateBus                                      = require(path.join(env.PROJECT_ROOT, 'bots/reservation/lib/state-bus.js'));
const DEV_HUB_READONLY                              = env.IS_DEV && !!env.HUB_BASE_URL && !process.env.PG_DIRECT;
const competitionRuntimeConfig                      = getBlogCompetitionRuntimeConfig();
const COMPETITION_ENABLED                           = competitionRuntimeConfig.enabled === true;
const COMPETITION_DAYS                              = Array.isArray(competitionRuntimeConfig.days) && competitionRuntimeConfig.days.length
  ? competitionRuntimeConfig.days
  : [1, 3, 5];

async function _selectBlogWriter(taskLabel, fallbackName, taskHint = null) {
  try {
    const bestWriter = await hiringContract.selectBestAgent('writer', 'blog', {
      limit: 5,
      mode: 'balanced',
      taskHint,
    });
    const writerName = bestWriter?.name || fallbackName;
    console.log(`[고용] ${taskLabel} 작가 선택: ${writerName} (점수: ${bestWriter?.score || 'N/A'}, specialty: ${bestWriter?.specialty || 'N/A'})`);
    return writerName;
  } catch (error) {
    console.warn(`[고용] ${taskLabel} 작가 선택 실패 — ${fallbackName} 폴백:`, error.message);
    return fallbackName;
  }
}

function _getNextFallbackGeneralCategory(currentCategory) {
  const categories = Array.isArray(GENERAL_CATEGORIES) ? GENERAL_CATEGORIES : [];
  if (!categories.length) return '자기계발';

  const currentIndex = categories.indexOf(currentCategory);
  const startIndex = currentIndex >= 0 ? currentIndex : 0;

  for (let offset = 1; offset <= categories.length; offset += 1) {
    const candidate = categories[(startIndex + offset) % categories.length];
    if (candidate && candidate !== '도서리뷰') return candidate;
  }

  return categories.find((category) => category !== '도서리뷰') || '자기계발';
}

function _extractTopicKeywords(researchData = {}) {
  const keywordSet = new Set();

  const pushKeyword = (value) => {
    const text = String(value || '').trim();
    if (!text) return;
    keywordSet.add(text);
  };

  pushKeyword(researchData?.it_news?.[0]?.title);
  pushKeyword(researchData?.it_news?.[1]?.title);
  pushKeyword(researchData?.nodejs_updates?.[0]?.name);
  pushKeyword(researchData?.nodejs_updates?.[0]?.tag);
  pushKeyword(researchData?.popularPatterns?.[0]?.title);

  [
    '개발자 성장',
    '소프트웨어 설계',
    '개발 조직 문화',
    'AI 개발',
    '생산성',
  ].forEach(pushKeyword);

  return [...keywordSet].slice(0, 8);
}

function _normalizeReviewedBookKey(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^가-힣a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _normalizeReviewedBookIsbn(value = '') {
  return String(value || '').replace(/[^0-9]/g, '');
}

async function _findExistingReviewedBook(bookInfo = {}) {
  const isbn = _normalizeReviewedBookIsbn(bookInfo.book_isbn || bookInfo.isbn);
  const titleKey = _normalizeReviewedBookKey(bookInfo.book_title || bookInfo.title);
  if (!isbn && !titleKey) return null;

  try {
    const rows = await pgPool.query('blog', `
      SELECT publish_date, book_title, book_author, book_isbn, status
      FROM blog.publish_schedule
      WHERE post_type = 'general'
        AND category = '도서리뷰'
        AND status IN ('ready', 'published', 'archived')
        AND (book_title IS NOT NULL OR book_isbn IS NOT NULL)
      ORDER BY publish_date DESC
    `);

    return (rows || []).find((row) => {
      const rowIsbn = _normalizeReviewedBookIsbn(row?.book_isbn);
      const rowTitleKey = _normalizeReviewedBookKey(row?.book_title);
      if (isbn && rowIsbn && isbn === rowIsbn) return true;
      if (titleKey && rowTitleKey && titleKey === rowTitleKey) return true;
      return false;
    }) || null;
  } catch (error) {
    console.warn('[블로] 도서리뷰 중복 이력 조회 실패:', error.message);
    return null;
  }
}

function _buildBookReviewSkillInput(researchData = {}) {
  const topic = String(
    researchData?.it_news?.[0]?.title
    || researchData?.nodejs_updates?.[0]?.name
    || '개발자 성장과 소프트웨어 설계'
  ).trim();

  return {
    topic,
    keywords: _extractTopicKeywords(researchData),
  };
}

// ─── 스키마 초기화 ────────────────────────────────────────────────────

async function ensureSchema() {
  try {
    await pgPool.run('blog', 'SELECT 1 FROM blog.daily_config LIMIT 1');
  } catch {
    console.warn('[블로] blog 스키마 미초기화 — 마이그레이션 필요: bots/blog/migrations/001-blog-schema.sql');
  }
}

async function prepareCompetition(topic, postType) {
  if (!COMPETITION_ENABLED) {
    return null;
  }
  const today = new Date().getDay();
  if (!COMPETITION_DAYS.includes(today)) {
    return null;
  }

  try {
    return await maestro.runCompetition(topic, postType);
  } catch (error) {
    console.warn(`[블로] 경쟁 준비 실패 — 기존 파이프라인으로 폴백 (${postType}):`, error.message);
    return null;
  }
}

// ─── State Bus 이벤트 발행 ────────────────────────────────────────────

async function _emitEvent(eventType, detail) {
  if (DEV_HUB_READONLY) return;
  try {
    await stateBus.emitEvent('blog-blo', 'claude-lead', eventType, detail);
  } catch (e) {
    console.warn(`[블로] State Bus 이벤트 실패 (${eventType}):`, e.message);
  }
}

// ─── RAG — 과거 포스팅 + 인기 패턴 ──────────────────────────────────

async function searchPastPosts(topic) {
  try {
    if (!DEV_HUB_READONLY) {
      await rag.initSchema();
    }
    const hits = await rag.search('blog', topic, { limit: 3, threshold: 0.6 });
    if (!hits?.length) return [];
    const filenames = hits
      .map((hit) => String(hit?.metadata?.filename || '').trim())
      .filter(Boolean);
    if (!filenames.length) return [];
    const rows = await pgPool.query('blog', `
      SELECT metadata->>'filename' AS filename
      FROM blog.posts
      WHERE status = 'published'
        AND metadata->>'filename' = ANY($1::text[])
    `, [filenames]);
    const publishedSet = new Set(rows.map((row) => String(row.filename || '').trim()).filter(Boolean));
    return hits.filter((hit) => publishedSet.has(String(hit?.metadata?.filename || '').trim()));
  } catch { return []; }
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

function _logQualityResult(quality, charCount) {
  console.log(`[품질] ${quality.passed ? '✅' : '❌'} ${charCount}자, AI리스크: ${quality.aiRisk?.riskLevel || '-'}, 이슈 ${quality.issues.length}건`);
  quality.issues.forEach(i => console.log(`  [${i.severity}] ${i.msg}`));
}

async function _runQualityRepair(kind, context, draft, variation, repairFn) {
  let post = draft;
  let quality = await checkQualityEnhanced(post.content, kind, {
    lectureNumber: kind === 'lecture' ? context.number : null,
    expectedLectureTitle: kind === 'lecture' ? context.lectureTitle : null,
    category: kind === 'general' ? context.category : null,
    bookInfo: kind === 'general' ? context.book_info || context.data?.book_info || null : null,
  });
  _logQualityResult(quality, post.charCount);

  for (let attempt = 0; attempt < 2 && (!quality.passed || quality.autoRewriteRecommended); attempt += 1) {
    console.log(`[품질] 초안 보정 시도... (${attempt + 1}/2)`);
    const retry = await repairFn(context, post, quality, variation);
    const retryQuality = await checkQualityEnhanced(retry.content, kind, {
      lectureNumber: kind === 'lecture' ? context.number : null,
      expectedLectureTitle: kind === 'lecture' ? context.lectureTitle : null,
      category: kind === 'general' ? context.category : null,
      bookInfo: kind === 'general' ? context.book_info || context.data?.book_info || null : null,
    });
    post = retry;
    quality = retryQuality;
    if (retryQuality.passed) {
      console.log('[품질] ✅ 초안 보정 통과');
      if (!retryQuality.autoRewriteRecommended) break;
    } else {
      console.log('[품질] ⚠️ 초안 보정 후에도 미달 — 추가 보정 여부 판단');
    }
  }

  return { post, quality, sectionVariation: variation, source: 'direct' };
}

async function _resolvePipelineExecution(postType, sectionVariation, payload, runLocalDraft) {
  const execution = await maestro.run(
    postType,
    variation => runLocalDraft(variation || sectionVariation),
    payload
  );

  return execution;
}

async function _createInstaContentSafe(content, title, category, label) {
  if (process.env.BLOG_INSTA_ENABLED === 'false') return null;
  const instaContent = await createInstaContent(content, title, category).catch(e => {
    console.warn(`[소셜] ${label} 생성 실패 (무시):`, e.message);
    return null;
  });
  if (instaContent) {
    console.log(`[소셜] ${label} 완료: 카드 ${instaContent.cards?.length}장 + 해시태그 ${instaContent.hashtags?.length}개`);
  }
  return instaContent;
}

async function _publishAndTrack(postData, scheduleId, traceCtx, eventDetail, options = {}) {
  if (options.dryRun) {
    console.log(`[블로][dry-run] 발행 생략: ${postData?.title || 'untitled'}`);
    return {
      dryRun: true,
      filename: null,
      postId: null,
      reused: true,
    };
  }

  const published = await publishToFile(postData);

  if (scheduleId) {
    await updateScheduleStatus(scheduleId, 'ready', published.postId);
  }

  await _emitEvent(eventDetail.type === 'lecture' ? 'post_completed' : 'post_completed', {
    ...eventDetail,
    traceId: traceCtx.trace_id,
  });

  if (published?.postId && postData?.performanceMetrics) {
    await recordPerformance(published.postId, postData.performanceMetrics);
  }

  return published;
}

async function _prepareLectureContext(researchData, traceCtx, preloaded = {}) {
  if (await isSeriesComplete()) {
    const next = await transitionSeries();
    if (!next) {
      const msg = '⚠️ [블로그팀] 강의 시리즈 완료!\n다음 시리즈가 아직 준비되지 않았습니다.\n텔레그램으로 승인 번호를 보내주세요.';
      console.log('[블로]', msg);
      const notice = buildNoticeEvent({
        from_bot: 'blog-blo',
        team: 'blog',
        event_type: 'alert',
        alert_level: 2,
        title: '강의 시리즈 완료',
        summary: '다음 시리즈가 아직 준비되지 않았습니다.',
        action: '텔레그램에서 승인 번호를 회신하세요.',
        payload: {
          title: '강의 시리즈 완료',
          summary: '다음 시리즈가 아직 준비되지 않았습니다.',
          action: '승인 번호 회신',
        },
      });
      await runIfOps(
        'blog-tg',
        () => postAlarm({
          message: renderNoticeEvent(notice) || msg,
          team: 'blog',
          alertLevel: notice.alert_level || 2,
          fromBot: 'blog-blo',
        }),
        () => console.log('[DEV] 텔레그램 생략')
      );
      return { skipped: true, result: { type: 'lecture', skipped: true, reason: '시리즈 완료 — 차기 준비 중' } };
    }
    console.log(`[블로] 🔄 시리즈 전환 완료 → ${next.series_name} 1강부터 시작`);
    return { skipped: true, result: { type: 'lecture', skipped: true, reason: `시리즈 전환: ${next.series_name}` } };
  }

  const sectionVariation = preloaded.sectionVariation || {};
  const { number, seriesName } = preloaded.number
    ? preloaded
    : await getNextLectureNumber();
  const lectureTitle = preloaded.lectureTitle
    || (await getLectureTitle(number, seriesName)) || `제${number}강`;

  console.log(`\n[포스] ${number}강: ${lectureTitle}`);
  const writeReq = createMessage('task_request', 'blog-blo', 'blog-pos', {
    lectureNumber: number,
    lectureTitle,
    traceId: traceCtx.trace_id,
  });
  console.log(`[블로] MessageEnvelope → 포스 (${writeReq.message_id.slice(0, 8)})`);

  const preparedResearch = { ...researchData };
  if (researchData.lecturePopularPatterns?.length) {
    preparedResearch.popularPatterns = researchData.lecturePopularPatterns;
  }
  const pastPosts = await searchPastPosts(lectureTitle);
  if (pastPosts.length > 0) {
    console.log(`[블로] 유사 과거 포스팅 ${pastPosts.length}건 발견 — 차별화 데이터 포함`);
    preparedResearch.pastPosts = pastPosts;
  }

  return {
    skipped: false,
    context: {
      number,
      seriesName,
      lectureTitle,
      sectionVariation,
      researchData: preparedResearch,
    },
  };
}

async function _prepareGeneralContext(researchData, traceCtx, preloaded = {}, scheduleId = null) {
  const { category } = preloaded.category ? preloaded : { category: '자기계발' };
  const sectionVariation = preloaded.sectionVariation || {};
  const needsBook = category === '도서리뷰';

  console.log(`\n[젬스] 일반 포스팅: ${category}`);
  const writeReq = createMessage('task_request', 'blog-blo', 'blog-gems', {
    category,
    traceId: traceCtx.trace_id,
  });
  console.log(`[블로] MessageEnvelope → 젬스 (${writeReq.message_id.slice(0, 8)})`);

  let preparedResearch = { ...researchData };
  if (preloaded.topicHint) {
    preparedResearch.topic_hint = String(preloaded.topicHint).trim();
  }
  if (!needsBook && !preparedResearch.topic_hint) {
    try {
      const recentPosts = getRecentPosts(category, 10);
      const selectedTopic = selectAndValidateTopic(category, recentPosts);
      preparedResearch.topic_hint = selectedTopic.topic;
      preparedResearch.topic_question = selectedTopic.question;
      preparedResearch.topic_diff = selectedTopic.diff;
      preparedResearch.topic_title_candidate = selectedTopic.title;
      console.log(`[젬스] 주제 다양화 선택: ${selectedTopic.title}${selectedTopic.forced ? ' (forced)' : ''}`);
    } catch (error) {
      console.warn('[젬스] 주제 다양화 선택 실패 — 기본 자율 주제 유지:', error.message);
    }
  }
  if (needsBook) {
    const scheduledBook = preloaded.bookInfo;
    if (scheduledBook?.book_title && scheduledBook?.book_isbn) {
      const duplicateBook = await _findExistingReviewedBook(scheduledBook);
      if (duplicateBook) {
        console.warn(
          `[젬스] 스케줄 도서 중복 감지 — ${scheduledBook.book_title} (${duplicateBook.publish_date}, ${duplicateBook.status})`
        );
        return {
          skipped: true,
          reason: `기존 도서리뷰와 중복: ${scheduledBook.book_title}`,
          category,
          sectionVariation,
        };
      }
      preparedResearch.book_info = {
        title: scheduledBook.book_title,
        author: scheduledBook.book_author || '',
        isbn: scheduledBook.book_isbn,
        source: 'schedule',
      };
      console.log(`[젬스] 스케줄 도서 정보 사용: ${scheduledBook.book_title} (ISBN: ${scheduledBook.book_isbn})`);
    } else if (scheduledBook?.book_title) {
      // ISBN 없는 스케줄 → resolveBookForReview로 보완
      console.log(`[젬스] 스케줄 도서 ISBN 없음 → 검색으로 보완: ${scheduledBook.book_title}`);
      try {
        const book = await blogSkills.bookReviewBook.resolveBookForReview({ topic: scheduledBook.book_title });
        if (book) {
          preparedResearch.book_info = book;
          if (scheduleId) {
            const { updateBookInfo } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/schedule.js'));
            await updateBookInfo(scheduleId, { book_title: book.title, book_author: book.author, book_isbn: book.isbn });
          }
        } else {
          console.warn('[젬스] 스케줄 도서 검색 보완 실패');
        }
      } catch (e) {
        console.warn('[젬스] 스케줄 도서 검색 보완 에러:', e.message);
      }
    } else {
      try {
        const skillInput = _buildBookReviewSkillInput(researchData);
        console.log(`[젬스] 도서리뷰 주제 선정: ${skillInput.topic}`);
        const book = await blogSkills.bookReviewBook.resolveBookForReview(skillInput);
        if (!book) {
          console.warn('[젬스] 도서 검색/선택/검증 실패 — 도서리뷰 스킵');
          return {
            skipped: true,
            reason: '도서 검색/선택/검증 실패',
            category,
            sectionVariation,
          };
        }

        preparedResearch.book_info = book;
        if (scheduleId && book?.title) {
          const { updateBookInfo } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/schedule.js'));
          await updateBookInfo(scheduleId, {
            book_title: book.title,
            book_author: book.author,
            book_isbn: book.isbn,
          });
        }
      } catch (e) {
        console.warn('[젬스] 도서 정보 수집/검증 실패 — 도서리뷰 스킵:', e.message);
        return {
          skipped: true,
          reason: `도서 정보 수집/검증 실패: ${e.message}`,
          category,
          sectionVariation,
        };
      }
    }
  }

  return {
    skipped: false,
    category,
    sectionVariation,
    researchData: preparedResearch,
    book_info: preparedResearch.book_info || null,
    topicHint: preparedResearch.topic_hint || null,
    topicQuestion: preparedResearch.topic_question || null,
    topicDiff: preparedResearch.topic_diff || null,
  };
}

async function _finalizeLecturePost(post, quality, context, scheduleId, traceCtx, writerName = null, options = {}) {
  const postTitle = `[Node.js ${context.number}강] ${context.lectureTitle}`;
  const published = await _publishAndTrack({
    title:         postTitle,
    content:       post.content,
    category:      'Node.js강의',
    postType:      'lecture',
    lectureNumber: context.number,
    charCount:     post.charCount,
    writerName,
    scheduleId,
  }, scheduleId, traceCtx, {
    type: 'lecture',
    number: context.number,
    title: context.lectureTitle,
    charCount: post.charCount,
  }, options);

  if (!options.dryRun && !published?.reused && !DEV_HUB_READONLY) {
    await advanceLectureNumber();
  } else if (published?.reused) {
    console.log(`[블로] 강의 ${context.number}강 재실행 감지 — 인덱스 증가 생략`);
  } else if (options.dryRun) {
    console.log(`[블로][dry-run] 강의 인덱스 증가 생략 (${context.number}강)`);
  } else {
    console.log(`[블로] DEV/HUB 읽기 전용 — 강의 인덱스 증가 생략 (${context.number}강)`);
  }

  const instaContent = options.dryRun
    ? null
    : await _createInstaContentSafe(
      post.content,
      postTitle,
      'Node.js강의',
      '강의 인스타'
    );

  return {
    type:         'lecture',
    number:       context.number,
    title:        context.lectureTitle,
    instaContent: instaContent || null,
    charCount:    post.charCount,
    quality:      quality.passed,
    aiRisk:       quality.aiRisk,
    filename:     published.filename,
    postId:       published.postId,
    dryRun:       !!options.dryRun,
    };
}

async function _finalizeGeneralPost(post, quality, context, scheduleId, traceCtx, writerName = null, options = {}) {
  if (!quality?.passed) {
    const qualityErrors = (quality?.issues || [])
      .filter(issue => issue?.severity === 'error')
      .map(issue => issue.msg)
      .slice(0, 3)
      .join(' | ');
    throw new Error(`일반 포스팅 품질 미달${qualityErrors ? `: ${qualityErrors}` : ''}`);
  }

  const genTitle = post.title || `[${context.category}] 오늘의 포스팅`;
  const images = options.dryRun
    ? null
    : await generatePostImages({ title: genTitle, postType: 'general', category: context.category }).catch(e => {
      console.warn('[이미지] 생성 실패 (일반):', e.message); return null;
    });
  if (!images && !options.dryRun) {
    console.log('[이미지] 일반 포스팅은 이미지 없이 발행 계속 진행');
  }

  const instaContent = options.dryRun
    ? null
    : await _createInstaContentSafe(
      post.content,
      genTitle,
      context.category,
      '인스타'
    );

  const published = await _publishAndTrack({
    title:     genTitle,
    content:   post.content,
    category:  context.category,
    postType:  'general',
    charCount: post.charCount,
    writerName,
    images,
    scheduleId,
  }, scheduleId, traceCtx, {
    type: 'general',
    category: context.category,
    title: post.title,
    charCount: post.charCount,
  }, options);

  if (!options.dryRun && !published?.reused && !DEV_HUB_READONLY) {
    await advanceGeneralCategory();
  } else if (published?.reused) {
    console.log(`[블로] 일반 포스팅 재실행 감지 (${context.category}) — 카테고리 증가 생략`);
  } else if (options.dryRun) {
    console.log(`[블로][dry-run] 일반 카테고리 증가 생략 (${context.category})`);
  } else {
    console.log(`[블로] DEV/HUB 읽기 전용 — 일반 카테고리 증가 생략 (${context.category})`);
  }

  return {
    type:         'general',
    category:     context.category,
    title:        post.title || `[${context.category}]`,
    charCount:    post.charCount,
    quality:      quality.passed,
    aiRisk:       quality.aiRisk,
    filename:     published.filename,
    postId:       published.postId,
    instaContent: instaContent || null,
    dryRun:       !!options.dryRun,
  };
}

async function _prepareDailyRun(traceCtx, options = {}) {
  await ensureSchema();

  const config = await getConfig();
  if (!config.active) {
    return { inactive: true, results: [] };
  }

  console.log(`[블로] 오늘 발행: 강의 ${config.lecture_count}편 + 일반 ${config.general_count}편`);

  const scheduleContext = await getTodayContext();
  const { lectureCtx, generalCtx, lectureSchedule, generalSchedule } = scheduleContext;
  console.log(`[블로] 스케줄 — 강의: ${lectureCtx ? `${lectureCtx.number}강` : '없음(이미발행)'} / 일반: ${generalCtx?.category || '없음(이미발행)'}`);

  const scheduleExists = lectureSchedule || generalSchedule;
  if (scheduleExists && !lectureCtx && !generalCtx) {
    return { complete: true, results: [] };
  }

  if (options.verifyOnly) {
    console.log('[블로][verify] 리서치/생성/발행 전 단계까지만 확인');
    return {
      inactive: false,
      complete: false,
      verifyOnly: true,
      config,
      researchData: null,
      ...scheduleContext,
    };
  }

  await _emitEvent('daily_start', {
    lecture_count: config.lecture_count,
    general_count: config.general_count,
    traceId: traceCtx.trace_id,
  });

  const researchData = await collectAllResearch('general', false);

  return {
    inactive: false,
    complete: false,
    config,
    researchData,
    ...scheduleContext,
  };
}

async function _sendDailyReport(results, traceCtx, options = {}) {
  const hasErrors = results.some(r => r.error);
  const reportLines = [
    '📝 [블로그팀] 일간 작업 완료',
    `🔖 trace: ${traceCtx.trace_id.slice(0, 8)}`,
    '',
    ...results.map(r => {
      if (r.error) return `❌ ${r.type}: ${r.error.slice(0, 60)}`;
      if (r.skipped) return `⏭ ${r.type}: ${r.reason}`;
      const label = r.type === 'lecture' ? `강의 ${r.number}강` : `일반[${r.category}]`;
      return `${r.quality ? '✅' : '⚠️'} ${label}: ${r.title?.slice(0, 30)} (${r.charCount}자)`;
    }),
    '',
    ...results.filter(r => !r.error && !r.skipped).map(r =>
      `${r.type === 'lecture' ? `[${r.number}강]` : `[${r.category}]`} ${_buildRewriteGuide(r.aiRisk)}`
    ),
    '',
    '📁 파일 위치: bots/blog/output/',
    '📅 예약 발행: 내일 오전 07:00',
  ];

  const reportEvent = buildReportEvent({
    from_bot: 'blog-blo',
    team: 'blog',
    event_type: 'report',
    alert_level: hasErrors ? 2 : 1,
    title: '블로그팀 일간 작업 완료',
    summary: `trace ${traceCtx.trace_id.slice(0, 8)} | ${results.length}건`,
    sections: [
      {
        title: '결과',
        lines: results.map(r => {
          if (r.error) return `❌ ${r.type}: ${r.error.slice(0, 60)}`;
          if (r.skipped) return `⏭ ${r.type}: ${r.reason}`;
          const label = r.type === 'lecture' ? `강의 ${r.number}강` : `일반[${r.category}]`;
          return `${r.quality ? '✅' : '⚠️'} ${label}: ${r.title?.slice(0, 30)} (${r.charCount}자)`;
        }),
      },
      {
        title: '리라이팅 가이드',
        lines: results.filter(r => !r.error && !r.skipped).map(r =>
          `${r.type === 'lecture' ? `[${r.number}강]` : `[${r.category}]`} ${_buildRewriteGuide(r.aiRisk)}`
        ),
      },
    ],
    footer: '파일 위치: bots/blog/output/ | 예약 발행: 내일 오전 07:00',
    payload: {
      title: '블로그팀 일간 작업 완료',
      summary: `trace ${traceCtx.trace_id.slice(0, 8)} | ${results.length}건`,
      details: reportLines,
    },
  });
  const renderedReport = renderReportEvent(reportEvent) || reportLines.join('\n');
  if (options.dryRun) {
    console.log('[블로][dry-run] 텔레그램 리포트 생략');
    console.log(renderedReport);
    return;
  }

  await runIfOps(
    'blog-tg',
    () => postAlarm({
      message: renderedReport,
      team: 'blog',
      alertLevel: reportEvent.alert_level || 1,
      fromBot: 'blog-blo',
    }),
    () => console.log('[DEV] 텔레그램 생략\n' + renderedReport)
  ).catch(e => console.warn('[블로] 텔레그램 발송 실패:', e.message));

  if (hasErrors) {
    const errMsg = `⚠️ [블로팀] 포스팅 실패 발생 — trace: ${traceCtx.trace_id.slice(0, 8)}`;
    const errNotice = buildNoticeEvent({
      from_bot: 'blog-blo',
      team: 'blog',
      event_type: 'alert',
      alert_level: 3,
      title: '블로그팀 포스팅 실패 발생',
      summary: `trace ${traceCtx.trace_id.slice(0, 8)}`,
      action: '/claude-health 또는 /reporting-health 확인',
      payload: {
        title: '블로그팀 포스팅 실패 발생',
        summary: `trace ${traceCtx.trace_id.slice(0, 8)}`,
        action: '/claude-health 또는 /reporting-health 확인',
      },
    });
    await runIfOps(
      'blog-tg-err',
      () => postAlarm({
        message: renderNoticeEvent(errNotice) || errMsg,
        team: 'claude',
        alertLevel: errNotice.alert_level || 3,
        fromBot: 'blog-blo',
      }),
      () => {}
    ).catch(() => {});
  }
}

// ─── 강의 포스팅 ──────────────────────────────────────────────────────

async function runLecturePost(researchData, traceCtx, preloaded = {}, scheduleId = null, options = {}) {
  const prepared = await _prepareLectureContext(researchData, traceCtx, preloaded);
  if (prepared.skipped) return prepared.result;
  const context = prepared.context;
  const startTime = Date.now();
  let contractId = null;
  const writerName = await _selectBlogWriter('강의', 'pos', '기술 강의 IT');

  try {
    const contract = await hiringContract.hire(writerName, {
      team: 'blog',
      description: `lecture: ${context.lectureTitle || '자동 주제'}`,
      requirements: { quality_min: 7.0, min_chars: 9000 },
    });
    contractId = contract.contractId;
  } catch (e) {
    console.warn('[shadow] hire 기록 실패 (무시):', e.message);
  }

  try {
    const result = await withTrace(traceCtx, async () => {
      const runLocalDraft = async variation => {
        let post;
        try {
          post = await writeLecturePostChunked(context.number, context.lectureTitle, context.researchData, variation);
        } catch (e) {
          console.warn('[블로] 강의 분할 생성 실패 — 단일 생성 폴백:', e.message);
          post = await writeLecturePost(context.number, context.lectureTitle, context.researchData, variation);
        }
        return _runQualityRepair(
          'lecture',
          context,
          post,
          variation,
          async (ctx, currentPost, quality) => repairLecturePostDraft(
            ctx.number,
            ctx.lectureTitle,
            ctx.researchData,
            currentPost,
            quality,
            variation
          )
        );
      };

      const { post, quality } = await _resolvePipelineExecution(
        'lecture',
        context.sectionVariation,
        {
          lectureNumber: context.number,
          lectureTitle: context.lectureTitle,
          topic: context.lectureTitle,
          dryRun: !!options.dryRun,
        },
        runLocalDraft
      );

      const finalized = await _finalizeLecturePost(post, quality, context, scheduleId, traceCtx, writerName, options);

      if (contractId) {
        try {
          await hiringContract.evaluate(contractId, {
            quality: Number(quality?.score || (quality?.passed ? 8 : 5)),
            char_count: post?.charCount || 0,
            duration_ms: Date.now() - startTime,
          }, null);
        } catch (e) {
          console.warn('[shadow] evaluate 기록 실패 (무시):', e.message);
        }
      }

      return finalized;
    });

    return result;
  } catch (error) {
    if (contractId) {
      try {
        await hiringContract.evaluate(contractId, {
          quality: 0,
          duration_ms: Date.now() - startTime,
          hallucination: false,
        }, null);
      } catch (e) {
        console.warn('[shadow] evaluate 실패 기록 (무시):', e.message);
      }
    }
    throw error;
  }
}

// ─── 일반 포스팅 ──────────────────────────────────────────────────────

async function runGeneralPost(researchData, traceCtx, preloaded = {}, scheduleId = null, options = {}) {
  const context = await _prepareGeneralContext(researchData, traceCtx, preloaded, scheduleId);
  if (context?.skipped) {
    const canFallbackCategory = context.category === '도서리뷰' && !preloaded._bookFallbackTried;
    if (canFallbackCategory) {
      await advanceGeneralCategory();
      const nextCategoryInfo = await getNextGeneralCategory();
      const fallbackCategory = nextCategoryInfo?.category === '도서리뷰'
        ? _getNextFallbackGeneralCategory(context.category)
        : (nextCategoryInfo?.category || _getNextFallbackGeneralCategory(context.category));
      if (scheduleId) {
        await updateScheduleCategory(scheduleId, fallbackCategory);
      }
      console.log(`[블로] 도서리뷰 스킵 — 같은 런에서 다음 일반 카테고리로 전환: ${fallbackCategory}`);
      return runGeneralPost(researchData, traceCtx, {
        ...preloaded,
        category: fallbackCategory,
        bookInfo: null,
        _bookFallbackTried: true,
      }, scheduleId);
    }
    if (!DEV_HUB_READONLY) {
      await advanceGeneralCategory();
    }
    return {
      type: 'general',
      skipped: true,
      reason: context.reason,
      category: context.category,
    };
  }
  const startTime = Date.now();
  let contractId = null;
  const writerName = await _selectBlogWriter(
    context.category === '도서리뷰' ? '도서리뷰' : '일반',
    'gems',
    context.category === '도서리뷰' ? '도서 감성 에세이' : (context.category || '에세이')
  );

  try {
    const contract = await hiringContract.hire(writerName, {
      team: 'blog',
      description: `general: ${context.category || '자동 주제'}`,
      requirements: { quality_min: 7.0, min_chars: 9000 },
    });
    contractId = contract.contractId;
  } catch (e) {
    console.warn('[shadow] hire 기록 실패 (무시):', e.message);
  }

  try {
    const result = await withTrace(traceCtx, async () => {
      const runLocalDraft = async variation => {
        let post;
        try {
          post = await writeGeneralPostChunked(context.category, context.researchData, variation);
        } catch (e) {
          console.warn('[블로] 일반 분할 생성 실패 — 단일 생성 폴백:', e.message);
          post = await writeGeneralPost(context.category, context.researchData, variation);
        }
        return _runQualityRepair(
          'general',
          { category: context.category, data: context.researchData },
          post,
          variation,
          async (ctx, currentPost, quality) => repairGeneralPostDraft(
            ctx.category,
            ctx.data,
            currentPost,
            quality,
            variation
          )
        );
      };

      const { post, quality } = await _resolvePipelineExecution(
        'general',
        context.sectionVariation,
        {
          category: context.category,
          topic: context.category,
          dryRun: !!options.dryRun,
        },
        runLocalDraft
      );

      const finalized = await _finalizeGeneralPost(post, quality, context, scheduleId, traceCtx, writerName, options);

      if (contractId) {
        try {
          await hiringContract.evaluate(contractId, {
            quality: Number(quality?.score || (quality?.passed ? 8 : 5)),
            char_count: post?.charCount || 0,
            duration_ms: Date.now() - startTime,
          }, null);
        } catch (e) {
          console.warn('[shadow] evaluate 기록 실패 (무시):', e.message);
        }
      }

      return finalized;
    });

    return result;
  } catch (error) {
    if (contractId) {
      try {
        await hiringContract.evaluate(contractId, {
          quality: 0,
          duration_ms: Date.now() - startTime,
          hallucination: false,
        }, null);
      } catch (e) {
        console.warn('[shadow] evaluate 실패 기록 (무시):', e.message);
      }
    }
    throw error;
  }
}

// ─── 메인 ───────────────────────────────────────────────────────────

async function run(options = {}) {
  console.log('\n📝 [블로] 블로그팀 일간 작업 시작\n');
  if (options.dryRun) {
    console.log('[블로][dry-run] 발행/스케줄 갱신/텔레그램 전송 없이 검증 실행');
  }
  if (options.verifyOnly) {
    console.log('[블로][verify] 설정/스케줄/핵심 의존성만 빠르게 점검');
  }

  const traceCtx = startTrace({ bot: 'blog-blo', action: 'daily_run' });
  console.log(`[블로] trace_id: ${traceCtx.trace_id}`);

  const daily = await _prepareDailyRun(traceCtx, options);
  if (daily.inactive) {
    console.log('[블로] 일시 정지 상태. 종료.');
    return [];
  }
  if (daily.complete) {
    console.log('[블로] ✅ 오늘 발행 항목이 모두 완료됨 — 중복 실행 건너뜀');
    return [];
  }
  if (daily.verifyOnly) {
    return [
      {
        type: 'verify',
        ok: true,
        dryRun: false,
        verifyOnly: true,
        lectureScheduled: !!daily.lectureCtx,
        generalScheduled: !!daily.generalCtx,
        lectureCount: Number(daily.config?.lecture_count || 0),
        generalCount: Number(daily.config?.general_count || 0),
      },
    ];
  }

  const {
    config,
    researchData,
    lectureCtx,
    generalCtx,
    lectureSchedule,
    generalSchedule,
  } = daily;

  const results = [];

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
        if (lectureSchedule?.id && !options.dryRun) await updateScheduleStatus(lectureSchedule.id, 'writing');

        if (!options.dryRun) await prepareCompetition(lectureTitle, 'lecture');

        const r = await runLecturePost(researchData, traceCtx, {
          number, seriesName, lectureTitle,
        }, lectureSchedule?.id, options);
        results.push(r);
      }
    } catch (e) {
      console.error('[블로] 강의 포스팅 실패:', e.message);
      if (lectureSchedule?.id && !options.dryRun) {
        await updateScheduleStatus(lectureSchedule.id, 'scheduled');
      }
      results.push({ type: 'lecture', error: e.message });
      await _emitEvent('post_failed', { type: 'lecture', error: e.message, traceId: traceCtx.trace_id });
    }
  }

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
      if (scheduleId && !options.dryRun) await updateScheduleStatus(scheduleId, 'writing');

      if (!options.dryRun) await prepareCompetition(category, 'general');

      const r = await runGeneralPost(researchData, traceCtx, {
        category,
        bookInfo,
      }, scheduleId, options);
      results.push(r);
    } catch (e) {
      console.error('[블로] 일반 포스팅 실패:', e.message);
      if (scheduleId && !options.dryRun) {
        await updateScheduleStatus(scheduleId, 'scheduled');
      }
      results.push({ type: 'general', error: e.message });
      await _emitEvent('post_failed', { type: 'general', error: e.message, traceId: traceCtx.trace_id });
    }
  }

  await _sendDailyReport(results, traceCtx, options);

  if (!options.dryRun) {
    await dailyCurriculumCheck().catch(e =>
      console.warn('[블로] 커리큘럼 체크 실패 (무시):', e.message)
    );
  } else {
    console.log('[블로][dry-run] 커리큘럼 체크 생략');
  }

  console.log('\n📝 [블로] 일간 작업 완료\n');
  return results;
}

module.exports = { run };
