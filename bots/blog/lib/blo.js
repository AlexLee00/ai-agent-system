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

const maestro                                       = require('./maestro');
const { generatePostImages }                        = require('./img-gen');
const { createInstaContent }                        = require('./star');
const { getConfig }                                 = require('./daily-config');
const {
  advanceGeneralCategory,
  getNextGeneralCategory,
  advanceLectureNumber,
  isSeriesComplete,
  getLectureTitle,
  getNextLectureNumber,
}                                                   = require('./category-rotation');
const {
  getTodayContext,
  updateScheduleStatus,
  updateScheduleCategory,
}                                                   = require('./schedule');
const { researchBook }                              = require('./book-research');
const { blog: blogSkills }                          = require('../../../packages/core/lib/skills');
const {
  dailyCurriculumCheck,
  transitionSeries,
}                                                   = require('./curriculum-planner');
const richer                                        = require('./richer');
const {
  writeLecturePost,
  writeLecturePostChunked,
  repairLecturePostDraft,
}                                                   = require('./pos-writer');
const {
  writeGeneralPost,
  writeGeneralPostChunked,
  repairGeneralPostDraft,
}                                                   = require('./gems-writer');
const { checkQualityEnhanced }                      = require('./quality-checker');
const { publishToFile, recordPerformance }          = require('./publ');
const pgPool                                        = require('../../../packages/core/lib/pg-pool');
const rag                                           = require('../../../packages/core/lib/rag-safe');
const hiringContract                                = require('../../../packages/core/lib/hiring-contract');
const { createMessage }                             = require('../../../packages/core/lib/message-envelope');
const { startTrace, withTrace, getTraceId }         = require('../../../packages/core/lib/trace');
const { runIfOps }                                  = require('../../../packages/core/lib/mode-guard');
const env                                           = require('../../../packages/core/lib/env');
const tg                                            = require('../../../packages/core/lib/telegram-sender');
const {
  buildReportEvent,
  renderReportEvent,
  buildNoticeEvent,
  renderNoticeEvent,
  publishEventPipeline,
  buildSeverityTargets,
}                                                   = require('../../../packages/core/lib/reporting-hub');
const stateBus                                      = require('../../../bots/reservation/lib/state-bus');
const pipelineStore                                 = require('./pipeline-store');
const DEV_HUB_READONLY                              = env.IS_DEV && !!env.HUB_BASE_URL && !process.env.PG_DIRECT;
const COMPETITION_DAYS                              = [1, 3, 5];

async function _selectBlogWriter(taskLabel, fallbackName) {
  try {
    const bestWriter = await hiringContract.selectBestAgent('writer', 'blog', { limit: 5 });
    const writerName = bestWriter?.name || fallbackName;
    console.log(`[고용] ${taskLabel} 작가 선택: ${writerName} (점수: ${bestWriter?.score || 'N/A'})`);
    return writerName;
  } catch (error) {
    console.warn(`[고용] ${taskLabel} 작가 선택 실패 — ${fallbackName} 폴백:`, error.message);
    return fallbackName;
  }
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
    return hits || [];
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

  if (execution?.n8nTriggered) {
    const writeNode = postType === 'lecture' ? 'write-lecture' : 'write-general';
    const post = await pipelineStore.getNodeResult(execution.sessionId, writeNode);
    const quality = await pipelineStore.getNodeResult(execution.sessionId, 'quality-check');
    if (post?.content && quality) {
      console.log(`[블로] n8n 결과 회수 완료 — session=${execution.sessionId}`);
      return { post, quality, source: 'n8n' };
    }

    console.warn('[블로] n8n 결과 회수 실패 — 로컬 생성 폴백');
    return await runLocalDraft(execution.variations || sectionVariation);
  }

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

async function _publishAndTrack(postData, scheduleId, traceCtx, eventDetail) {
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
        () => publishEventPipeline({
      event: { ...notice, message: renderNoticeEvent(notice) || msg },
      targets: buildSeverityTargets({
        event: notice,
        topicTeam: 'blog',
        includeQueue: false,
        includeTelegram: false,
        includeN8n: false,
      }),
      policy: { cooldownMs: 30 * 60_000 },
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
  if (needsBook) {
    const scheduledBook = preloaded.bookInfo;
    if (scheduledBook?.book_title) {
      preparedResearch.book_info = scheduledBook;
      console.log(`[젬스] 스케줄 도서 정보 사용: ${scheduledBook.book_title}`);
    } else {
      try {
        const book = await researchBook();
        const verification = blogSkills.bookSourceVerify.verifyBookSources({
          primary: book,
          candidates: book?.verification_candidates || [book],
        });
        if (!verification.ok) {
          console.warn(`[젬스] 도서 검증 실패 — 도서리뷰 스킵: ${verification.reasons.join(', ')}`);
          return {
            skipped: true,
            reason: `도서 검증 실패: ${verification.reasons.join(', ')}`,
            category,
            sectionVariation,
          };
        }

        preparedResearch.book_info = verification.book;
        if (scheduleId && verification.book?.title) {
          const { updateBookInfo } = require('./schedule');
          await updateBookInfo(scheduleId, {
            book_title: verification.book.title,
            book_author: verification.book.author,
            book_isbn: verification.book.isbn,
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
  };
}

async function _finalizeLecturePost(post, quality, context, scheduleId, traceCtx) {
  const postTitle = `[Node.js ${context.number}강] ${context.lectureTitle}`;
  const published = await _publishAndTrack({
    title:         postTitle,
    content:       post.content,
    category:      'Node.js강의',
    postType:      'lecture',
    lectureNumber: context.number,
    charCount:     post.charCount,
    scheduleId,
  }, scheduleId, traceCtx, {
    type: 'lecture',
    number: context.number,
    title: context.lectureTitle,
    charCount: post.charCount,
  });

  if (!published?.reused && !DEV_HUB_READONLY) {
    await advanceLectureNumber();
  } else if (published?.reused) {
    console.log(`[블로] 강의 ${context.number}강 재실행 감지 — 인덱스 증가 생략`);
  } else {
    console.log(`[블로] DEV/HUB 읽기 전용 — 강의 인덱스 증가 생략 (${context.number}강)`);
  }

  const instaContent = await _createInstaContentSafe(
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
  };
}

async function _finalizeGeneralPost(post, quality, context, scheduleId, traceCtx) {
  const genTitle = post.title || `[${context.category}] 오늘의 포스팅`;
  const images = await generatePostImages({ title: genTitle, postType: 'general', category: context.category }).catch(e => {
    console.warn('[이미지] 생성 실패 (일반):', e.message); return null;
  });
  if (!images) {
    console.log('[이미지] 일반 포스팅은 이미지 없이 발행 계속 진행');
  }

  const instaContent = await _createInstaContentSafe(
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
    images,
    scheduleId,
  }, scheduleId, traceCtx, {
    type: 'general',
    category: context.category,
    title: post.title,
    charCount: post.charCount,
  });

  if (!published?.reused && !DEV_HUB_READONLY) {
    await advanceGeneralCategory();
  } else if (published?.reused) {
    console.log(`[블로] 일반 포스팅 재실행 감지 (${context.category}) — 카테고리 증가 생략`);
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
  };
}

async function _prepareDailyRun(traceCtx) {
  await ensureSchema();

  const config = await getConfig();
  if (!config.active) {
    return { inactive: true, results: [] };
  }

  console.log(`[블로] 오늘 발행: 강의 ${config.lecture_count}편 + 일반 ${config.general_count}편`);

  await _emitEvent('daily_start', {
    lecture_count: config.lecture_count,
    general_count: config.general_count,
    traceId: traceCtx.trace_id,
  });

  const researchData = await richer.research('general', false);
  researchData.popularPatterns = await richer.searchPopularPatterns('general');
  researchData.lecturePopularPatterns = await richer.searchPopularPatterns('lecture');

  const scheduleContext = await getTodayContext();
  const { lectureCtx, generalCtx, lectureSchedule, generalSchedule } = scheduleContext;
  console.log(`[블로] 스케줄 — 강의: ${lectureCtx ? `${lectureCtx.number}강` : '없음(이미발행)'} / 일반: ${generalCtx?.category || '없음(이미발행)'}`);

  const scheduleExists = lectureSchedule || generalSchedule;
  if (scheduleExists && !lectureCtx && !generalCtx) {
    return { complete: true, results: [] };
  }

  return {
    inactive: false,
    complete: false,
    config,
    researchData,
    ...scheduleContext,
  };
}

async function _sendDailyReport(results, traceCtx) {
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
  await runIfOps(
    'blog-tg',
    () => publishEventPipeline({
      event: { ...reportEvent, message: renderedReport },
      targets: buildSeverityTargets({
        event: reportEvent,
        sender: tg,
        topicTeam: 'blog',
        includeQueue: false,
        includeN8n: false,
      }),
      policy: { cooldownMs: 30 * 60_000 },
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
      () => publishEventPipeline({
        event: { ...errNotice, message: renderNoticeEvent(errNotice) || errMsg },
        targets: buildSeverityTargets({
          event: errNotice,
          sender: tg,
          topicTeam: 'claude-lead',
          includeQueue: false,
        }),
        policy: { cooldownMs: 10 * 60_000 },
      }),
      () => {}
    ).catch(() => {});
  }
}

// ─── 강의 포스팅 ──────────────────────────────────────────────────────

async function runLecturePost(researchData, traceCtx, preloaded = {}, scheduleId = null) {
  const prepared = await _prepareLectureContext(researchData, traceCtx, preloaded);
  if (prepared.skipped) return prepared.result;
  const context = prepared.context;
  const startTime = Date.now();
  let contractId = null;
  const writerName = await _selectBlogWriter('강의', 'pos');

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
        },
        runLocalDraft
      );

      const finalized = await _finalizeLecturePost(post, quality, context, scheduleId, traceCtx);

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

async function runGeneralPost(researchData, traceCtx, preloaded = {}, scheduleId = null) {
  const context = await _prepareGeneralContext(researchData, traceCtx, preloaded, scheduleId);
  if (context?.skipped) {
    const canFallbackCategory = context.category === '도서리뷰' && !preloaded._bookFallbackTried;
    if (canFallbackCategory) {
      await advanceGeneralCategory();
      const nextCategoryInfo = await getNextGeneralCategory();
      if (scheduleId) {
        await updateScheduleCategory(scheduleId, nextCategoryInfo.category);
      }
      console.log(`[블로] 도서리뷰 스킵 — 같은 런에서 다음 일반 카테고리로 전환: ${nextCategoryInfo.category}`);
      return runGeneralPost(researchData, traceCtx, {
        ...preloaded,
        category: nextCategoryInfo.category,
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
  const writerName = await _selectBlogWriter('일반', 'gems');

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
        },
        runLocalDraft
      );

      const finalized = await _finalizeGeneralPost(post, quality, context, scheduleId, traceCtx);

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

async function run() {
  console.log('\n📝 [블로] 블로그팀 일간 작업 시작\n');

  const traceCtx = startTrace({ bot: 'blog-blo', action: 'daily_run' });
  console.log(`[블로] trace_id: ${traceCtx.trace_id}`);

  const daily = await _prepareDailyRun(traceCtx);
  if (daily.inactive) {
    console.log('[블로] 일시 정지 상태. 종료.');
    return [];
  }
  if (daily.complete) {
    console.log('[블로] ✅ 오늘 발행 항목이 모두 완료됨 — 중복 실행 건너뜀');
    return [];
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
        if (lectureSchedule?.id) await updateScheduleStatus(lectureSchedule.id, 'writing');

        await prepareCompetition(lectureTitle, 'lecture');

        const r = await runLecturePost(researchData, traceCtx, {
          number, seriesName, lectureTitle,
        }, lectureSchedule?.id);
        results.push(r);
      }
    } catch (e) {
      console.error('[블로] 강의 포스팅 실패:', e.message);
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
      if (scheduleId) await updateScheduleStatus(scheduleId, 'writing');

      await prepareCompetition(category, 'general');

      const r = await runGeneralPost(researchData, traceCtx, {
        category,
        bookInfo,
      }, scheduleId);
      results.push(r);
    } catch (e) {
      console.error('[블로] 일반 포스팅 실패:', e.message);
      results.push({ type: 'general', error: e.message });
      await _emitEvent('post_failed', { type: 'general', error: e.message, traceId: traceCtx.trace_id });
    }
  }

  await _sendDailyReport(results, traceCtx);

  await dailyCurriculumCheck().catch(e =>
    console.warn('[블로] 커리큘럼 체크 실패 (무시):', e.message)
  );

  console.log('\n📝 [블로] 일간 작업 완료\n');
  return results;
}

module.exports = { run };
