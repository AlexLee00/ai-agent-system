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
const kst                                           = require('../../../packages/core/lib/kst');
const maestro                                       = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/maestro.ts'));
const { generatePostImages }                        = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/img-gen.ts'));
const { createInstaContent }                        = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/star.ts'));
const { getConfig }                                 = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/daily-config.ts'));
const {
  GENERAL_CATEGORIES,
  advanceGeneralCategory,
  getNextGeneralCategory,
  advanceLectureNumber,
  isSeriesComplete,
  getLectureTitle,
  getNextLectureNumber,
}                                                   = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/category-rotation.ts'));
const {
  getTodayContext,
  updateScheduleStatus,
  updateScheduleCategory,
}                                                   = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/schedule.ts'));
const { getBlogCompetitionRuntimeConfig }           = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/runtime-config.ts'));
const blogSkills = {
  bookReviewBook: require(path.join(env.PROJECT_ROOT, 'packages/core/lib/skills/blog/book-review-book.ts')),
};
const {
  dailyCurriculumCheck,
  transitionSeries,
}                                                   = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/curriculum-planner.ts'));
const richer                                        = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/richer.ts'));
const { collectAllResearch }                        = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/parallel-collector.ts'));
const {
  getRecentPosts,
  selectAndValidateTopic,
  selectTopicWithCandidateFallback,
  synthesizeHybridTopic,
  getPendingLunaRequest,
}                                                   = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/topic-selector.ts'));
const { runTopicPlanner }                           = require(path.join(env.PROJECT_ROOT, 'bots/blog/scripts/topic-planner.ts'));
const { checkInvestmentContent }                    = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/investment-guard.ts'));
const { isExcludedReferencePost }                   = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/reference-exclusions.ts'));
const { agenticSearch }                             = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/agentic-rag.ts'));
const { getWriterPersona }                          = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/writer-personas.ts'));
const { pickEditorPersona }                         = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/editor-personas.ts'));
const { loadLatestStrategy }                        = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/strategy-loader.ts'));
const { normalizeExecutionDirectives }             = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/strategy-loader.ts'));
const { senseDailyState }                          = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/sense-engine.ts'));
const { analyzeMarketingToRevenue }                = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/marketing-revenue-correlation.ts'));
const { recordPublishedExperimentRun }             = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/experiment-os.ts'));
const { readExperimentPlaybook }                   = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/experiment-os.ts'));
const { fetchRevenueAttributionWeights }           = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/topic-selector.ts'));
const { detectTitlePattern }                       = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/performance-diagnostician.ts'));
const { decideAutonomy }                           = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/autonomy-gate.ts'));
const { accumulatePostExperience }                 = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/rag-accumulator.ts'));
const {
  writeLecturePost,
  writeLecturePostChunked,
  repairLecturePostDraft,
}                                                   = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/pos-writer.ts'));
const {
  writeGeneralPost,
  writeGeneralPostChunked,
  repairGeneralPostDraft,
}                                                   = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/gems-writer.ts'));
const { ensureBlogCoreSchema }                      = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/schema.ts'));
const { checkQualityEnhanced }                      = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/quality-checker.ts'));
const { publishToFile, recordPerformance }          = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/publ.ts'));
const { crosspostToInstagram }                      = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/insta-crosspost.ts'));
const { hasRemainingPublishQuota }                  = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/platform-orchestrator.ts'));
const {
  diagnoseImageGeneration,
  reportImageGenFailure,
  reportImageDiagnosis,
}                                                   = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/img-gen-doctor.ts'));
const { buildDailyReportContract }                  = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/report-contract.ts'));
const pgPool                                        = require('../../../packages/core/lib/pg-pool');
const rag                                           = require('../../../packages/core/lib/rag-safe');
const hiringContract                                = require('../../../packages/core/lib/hiring-contract');
const { createMessage }                             = require('../../../packages/core/lib/message-envelope');
const { startTrace, withTrace, getTraceId }         = require('../../../packages/core/lib/trace');
const { runIfOps }                                  = require('../../../packages/core/lib/mode-guard');
const { postAlarm }                                 = require('../../../packages/core/lib/hub-alarm-client');
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

function _sleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function _isRetryableBlogStageError(error) {
  const message = String(error?.message || error || '').trim();
  if (!message) return false;
  return (
    message.includes('hub_llm_call_failed:타임아웃')
    || message.includes('hub_llm_call_failed:fetch failed')
    || message.includes('hub_llm_call_failed:provider_cooldown')
    || message.includes('agent 실행 실패')
    || message.includes('Claude Code timeout')
    || message.includes('GoogleGenerativeAI Error')
    || message.includes('Error fetching from https://')
    || message.includes('503 Service Unavailable')
    || message.includes('429 Too Many Requests')
    || message.includes('fetch failed')
    || message.includes('ECONNRESET')
    || message.includes('ETIMEDOUT')
    || message.includes('socket hang up')
  );
}

async function _runWithStageRetry(label, runner, options = {}) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts || 2));
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs || 5000));
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await runner(attempt);
    } catch (error) {
      lastError = error;
      const retryable = _isRetryableBlogStageError(error);
      if (!retryable || attempt >= maxAttempts) throw error;
      console.warn(`[블로] ${label} 일시 오류 — ${attempt}/${maxAttempts} 재시도 대기:`, error.message);
      await _sleep(retryDelayMs);
    }
  }
  throw lastError || new Error(`${label} 실행 실패`);
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
    '인문학',
    '베스트셀러 소설',
    '삶을 돌아보는 책',
    '요즘 많이 읽는 책',
    '일과 사람에 대한 통찰',
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

async function _buildBookReviewSkillInput(researchData = {}) {
  let preferredBooks = [];
  let queuedBooks = [];
  let reviewedHistory = [];
  try {
    queuedBooks = await blogSkills.bookReviewBook.listBookReviewQueue({ limit: 6, status: 'queued' });
  } catch (error) {
    console.warn('[블로] 도서리뷰 큐 로드 실패:', error.message);
  }
  try {
    preferredBooks = await blogSkills.bookReviewBook.loadCatalogBooks();
  } catch (error) {
    console.warn('[블로] book_catalog 기반 도서리뷰 후보 로드 실패:', error.message);
  }
  try {
    reviewedHistory = await blogSkills.bookReviewBook.loadReviewedBookHistory();
  } catch (error) {
    console.warn('[블로] 도서리뷰 최근 이력 로드 실패:', error.message);
  }

  const queuedSeeds = Array.isArray(queuedBooks)
    ? queuedBooks.map((book) => ({
      title: book.title,
      author: book.author,
      isbn: book.isbn || '',
      category: book.category || '기타',
      priority: Number(book.priority || 50),
      source: book.source || 'queue',
    }))
    : [];
  const catalogSeeds = Array.isArray(preferredBooks)
    ? blogSkills.bookReviewBook.buildDiversePreferredBooks(preferredBooks, 6, reviewedHistory)
    : [];
  const preferredSeeds = [...queuedSeeds, ...catalogSeeds].slice(0, 6);
  const topic = String(
    researchData?.it_news?.[0]?.title
    || researchData?.nodejs_updates?.[0]?.name
    || preferredSeeds?.[0]?.title
    || '일과 삶을 함께 돌아보게 만드는 책'
  ).trim();

  return {
    topic,
    keywords: [
      ..._extractTopicKeywords(researchData),
      ...preferredSeeds.map((book) => [book.title, book.author].filter(Boolean).join(' ')),
    ],
    preferredBooks: preferredSeeds,
  };
}

function _buildMarketingResearchContext(category, dailyState = {}) {
  const senseState = dailyState?.senseState || null;
  const revenueCorrelation = dailyState?.revenueCorrelation || null;
  const signals = Array.isArray(senseState?.signals) ? senseState.signals : [];
  const signalTypes = signals.map((signal) => String(signal?.type || '')).filter(Boolean);
  const recommendations = [];
  let ctaHint = '';

  if (signalTypes.includes('revenue_anomaly') || signalTypes.includes('revenue_decline') || Number(revenueCorrelation?.revenueImpactPct || 0) < 0) {
    recommendations.push('매출/전환 하락 신호가 있어 독자가 바로 행동할 수 있는 CTA를 과하지 않게 연결');
    if (['홈페이지와App', '개발기획과컨설팅', '성장과성공'].includes(category)) {
      ctaHint = '체험 예약, 문의, 상담, 방문 유도 중 하나를 본문 후반부에 자연스럽게 연결';
    }
  }

  if (signalTypes.includes('exam_period') || Number(senseState?.skaEnvironment?.exam_score || 0) > 0) {
    recommendations.push('시험기간 신호가 있어 학습 효율, 몰입 환경, 루틴 유지 포인트를 본문에 포함');
    if (!ctaHint) {
      ctaHint = '시험기간 독자가 바로 적용할 집중 루틴 또는 학습 효율 팁을 결론부에 연결';
    }
  }

  if (signalTypes.includes('holiday') || !!senseState?.skaEnvironment?.holiday_flag) {
    recommendations.push('공휴일 맥락이 있어 무겁기보다 가볍게 읽히는 체크리스트형 전개를 우선');
  }

  return {
    marketing_signal_summary: signalTypes.length ? signalTypes.join(' / ') : '특이 신호 없음',
    marketing_recommendations: recommendations,
    marketing_cta_hint: ctaHint,
  };
}

function _normalizeTitleTokens(text = '') {
  return String(text || '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 2);
}

function _calculateTitleTokenOverlap(a = '', b = '') {
  const first = new Set(_normalizeTitleTokens(a));
  const second = new Set(_normalizeTitleTokens(b));
  if (!first.size || !second.size) return 0;
  let matched = 0;
  for (const token of first) {
    if (second.has(token)) matched += 1;
  }
  return Number((matched / Math.max(first.size, second.size)).toFixed(2));
}

function _buildGeneralTitleAlignmentMetadata(post, context = {}) {
  const previewTitle = String(context?.researchData?.topic_title_candidate || '').trim();
  const previewPattern = String(context?.researchData?.strategy_preferred_pattern || '').trim();
  const finalTitle = String(post?.title || '').trim();
  const finalPattern = detectTitlePattern(finalTitle.replace(/^\[[^\]]+\]\s*/, '').trim());
  const overlap = previewTitle ? _calculateTitleTokenOverlap(finalTitle, previewTitle) : 0;
  const categoryAligned = String(context?.category || '').trim() === String(context?.strategyPlan?.preferredCategory || context?.category || '').trim();
  const patternAligned = previewPattern ? finalPattern === previewPattern : false;
  const aligned = Boolean(previewTitle) && categoryAligned && patternAligned && overlap >= 0.4;

  return {
    preview_category: context?.category || null,
    preview_title: previewTitle || null,
    preview_pattern: previewPattern || null,
    final_title: finalTitle || null,
    final_pattern: finalPattern || null,
    title_overlap: overlap,
    category_aligned: categoryAligned,
    pattern_aligned: patternAligned,
    aligned,
  };
}

function _applyGeneralTopicStrategy(preparedResearch, category, strategyPlan, dailyState = {}, selectedTopicOverride = null) {
  if (preparedResearch.topic_hint) return preparedResearch;

  const recentPosts = getRecentPosts(category, 10);
  const selectedTopic = selectedTopicOverride || selectAndValidateTopic(
    category,
    recentPosts,
    strategyPlan,
    dailyState?.senseState || null,
    dailyState?.revenueCorrelation || null
  );
  const marketingContext = _buildMarketingResearchContext(category, dailyState);
  const experimentPlaybook = readExperimentPlaybook() || null;
  const experimentDimensionKey = experimentPlaybook?.topWinner?.dimension === 'title_pattern'
    ? 'titlePattern'
    : experimentPlaybook?.topWinner?.dimension === 'autonomy_lane'
      ? 'autonomyLane'
      : 'category';
  const experimentLoser = experimentPlaybook?.dimensions?.[experimentDimensionKey]?.loser || null;
  const experimentWinnerSummary = strategyPlan?.experimentLearning?.topWinnerSummary
    || (
      experimentPlaybook?.topWinner?.variant
        ? `최근 실험 승자는 ${experimentPlaybook.topWinner.dimension}:${experimentPlaybook.topWinner.variant} (${Math.round(Number(experimentPlaybook.topWinner.liftPct || 0) * 100)}% lift, n=${experimentPlaybook.topWinner.sampleCount}) 입니다.`
        : ''
    );
  const experimentWeakLaneSummary = strategyPlan?.experimentLearning?.weakestVariantSummary
    || (
      experimentLoser?.variant
        ? `최근 약한 레인은 ${experimentLoser.dimension}:${experimentLoser.variant} (${Math.round(Number(experimentLoser.liftPct || 0) * 100)}% lift, n=${experimentLoser.sampleCount}) 입니다.`
        : ''
    );

  return {
    ...preparedResearch,
    topic_hint: selectedTopic.topic,
    topic_question: selectedTopic.question,
    topic_diff: selectedTopic.diff,
    topic_title_candidate: selectedTopic.title,
    topic_reader_problem: selectedTopic.readerProblem || '',
    topic_opening_angle: selectedTopic.openingAngle || '',
    topic_key_questions: Array.isArray(selectedTopic.keyQuestions) ? selectedTopic.keyQuestions : [],
    topic_closing_angle: selectedTopic.closingAngle || '',
    topic_freshness_summary: selectedTopic.freshnessSummary || '',
    topic_marketing_signal_summary: selectedTopic.marketingSignalSummary || marketingContext.marketing_signal_summary,
    topic_marketing_recommendations: Array.isArray(selectedTopic.marketingRecommendations) ? selectedTopic.marketingRecommendations : marketingContext.marketing_recommendations,
    topic_marketing_cta_hint: selectedTopic.marketingCtaHint || marketingContext.marketing_cta_hint,
    topic_selection_source: selectedTopic.source || (selectedTopic.forced ? 'runtime_pool' : 'runtime_selector'),
    topic_selection_id: selectedTopic.id || null,
    topic_selection_target_date: selectedTopic.targetDate || selectedTopic.target_date || null,
    strategy_focus: Array.isArray(strategyPlan?.focus) ? strategyPlan.focus : [],
    strategy_recommendations: [
      ...(Array.isArray(strategyPlan?.recommendations) ? strategyPlan.recommendations : []),
      ...(Array.isArray(selectedTopic.marketingRecommendations) ? selectedTopic.marketingRecommendations : []),
    ],
    strategy_preferred_pattern: strategyPlan?.preferredTitlePattern || null,
    strategy_suppressed_pattern: strategyPlan?.suppressedTitlePattern || null,
    strategy_experiment_winner: experimentWinnerSummary,
    strategy_experiment_weak_lane: experimentWeakLaneSummary,
    _selectedTopic: selectedTopic,
  };
}

function _getBlogRunDate() {
  return process.env.BLOG_RUN_DATE || kst.today();
}

function _normalizeBlogRunDate(value = null) {
  if (!value) return _getBlogRunDate();
  if (value instanceof Date) return value.toLocaleDateString('sv-SE', { timeZone: kst.TZ || 'Asia/Seoul' });
  const text = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : text.slice(0, 10);
}

function _isDbBackedTopicSelection(selectedTopic = null) {
  return ['topic_queue', 'db_curated'].includes(String(selectedTopic?.source || ''));
}

async function _selectGeneralTopicForRun(category, strategyPlan, dailyState = {}, options = {}) {
  const targetDate = _normalizeBlogRunDate(options.targetDate);
  const recentPosts = getRecentPosts(category, 10);
  const select = () => selectTopicWithCandidateFallback(
    category,
    targetDate,
    recentPosts,
    strategyPlan,
    dailyState?.senseState || null,
    dailyState?.revenueCorrelation || null,
    Array.isArray(options.itNews) ? options.itNews : []
  );

  let selectedTopic = await select();
  if (_isDbBackedTopicSelection(selectedTopic)) {
    return { ...selectedTopic, targetDate };
  }

  if (options.dryRun || DEV_HUB_READONLY) {
    console.log(`[젬스] ${targetDate} 사전 후보 없음 — dry-run/read-only라 런타임 풀 선택 사용: ${selectedTopic.title}`);
    return { ...selectedTopic, targetDate };
  }

  try {
    console.log(`[젬스] ${targetDate} 사전 후보 없음 — 당일 후보 생성 후 재선택`);
    await runTopicPlanner({
      targetDate,
      category,
      silent: true,
    });
    selectedTopic = await select();
    if (_isDbBackedTopicSelection(selectedTopic)) {
      console.log(`[젬스] 당일 생성 후보 선택: ${selectedTopic.title} (${selectedTopic.source})`);
      return { ...selectedTopic, targetDate };
    }
    console.warn(`[젬스] 당일 후보 생성 후에도 DB 후보 선택 실패 — 런타임 풀 선택 사용: ${selectedTopic.title}`);
  } catch (error) {
    console.warn('[젬스] 당일 후보 생성 실패 — 런타임 풀 선택 사용:', error.message);
  }

  return { ...selectedTopic, targetDate };
}

async function _markGeneralTopicSelectionConsumed(context = {}, finalized = null, options = {}) {
  if (options.dryRun || DEV_HUB_READONLY || !finalized?.postId) return;
  const source = String(context?.researchData?.topic_selection_source || '').trim();
  const id = Number(context?.researchData?.topic_selection_id || 0);
  if (!id || !['topic_queue', 'db_curated'].includes(source)) return;

  try {
    if (source === 'topic_queue') {
      await pgPool.run('blog', `
        UPDATE blog.topic_queue
        SET status = 'consumed',
            consumed_at = NOW()
        WHERE id = $1
          AND status = 'pending'
      `, [id]);
      await pgPool.run('blog', `
        UPDATE blog.topic_candidates
        SET status = 'selected',
            selected_at = NOW()
        WHERE target_date = $1
          AND category = $2
          AND title = $3
          AND status = 'pending'
      `, [
        _normalizeBlogRunDate(context?.researchData?.topic_selection_target_date),
        context?.category || '',
        context?.researchData?.topic_title_candidate || '',
      ]);
      return;
    }

    await pgPool.run('blog', `
      UPDATE blog.topic_candidates
      SET status = 'selected',
          selected_at = NOW()
      WHERE id = $1
        AND status = 'pending'
    `, [id]);
  } catch (error) {
    console.warn('[젬스] 선택 주제 consume 처리 실패 (무시):', error.message);
  }
}

function _resolveGeneralPipelineTopic(context = {}) {
  const researchData = context?.researchData || {};
  return String(
    context.topicHint
    || researchData.topic_hint
    || researchData.topic_title_candidate
    || context.category
    || ''
  ).trim();
}

async function _updateScheduledBookInfo(scheduleId, book) {
  if (!scheduleId || !book?.title) return;
  const { updateBookInfo } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/schedule.ts'));
  await updateBookInfo(scheduleId, {
    book_title: book.title,
    book_author: book.author,
    book_isbn: book.isbn,
  });
}

async function _markBookReviewQueueStatus(book, status, extra = {}) {
  if (!book?.title && !book?.isbn) return;
  try {
    await blogSkills.bookReviewBook.updateBookReviewQueueEntry({
      isbn: book?.isbn || null,
      title: book?.title || null,
      status,
      postId: extra.postId || null,
      note: extra.note || null,
    });
  } catch (error) {
    console.warn(`[블로] 도서리뷰 큐 상태 갱신 실패(${status}):`, error.message);
  }
}

async function _refillBookReviewQueue(targetSize = 5) {
  try {
    const strategyPlan = loadLatestStrategy();
    const directives = normalizeExecutionDirectives(strategyPlan);
    const dynamicTargetSize = Math.max(
      3,
      Math.min(
        12,
        Number(targetSize || 0)
        || (Number(directives.executionTargets.blogRegistrationsPerCycle || 1) * 3)
      )
    );
    const result = await blogSkills.bookReviewBook.buildBookReviewQueue({ limit: dynamicTargetSize });
    if (Number(result?.inserted || 0) > 0) {
      console.log(`[블로] 도서리뷰 큐 자동 보충: ${result.inserted}건 추가`);
    }
  } catch (error) {
    console.warn('[블로] 도서리뷰 큐 자동 보충 실패:', error.message);
  }
}

function _buildBookReviewTopicMeta(bookInfo = {}) {
  const title = String(bookInfo.title || '').trim();
  const primaryAuthor = String(bookInfo.author || '').split(/[\^,]/)[0].trim();
  if (!title) return {};
  return {
    topic_hint: `${title}를 읽고 지금 다시 붙잡아야 할 질문`,
    topic_question: `${title}는 지금 어떤 독자에게 왜 다시 읽힐 가치가 있는가`,
    topic_diff: '줄거리 요약보다 핵심 주장과 실무 적용 포인트 중심으로 정리',
    topic_title_candidate: `${title}를 읽고 지금 다시 보게 된 질문 3가지`,
    topic_reader_problem: '책 소개보다 이 책이 지금 왜 유효한지 알고 싶은 독자',
    topic_opening_angle: primaryAuthor
      ? `${primaryAuthor}의 문제의식을 오늘의 일과 삶에 다시 연결하는 장면에서 시작`
      : '책의 핵심 문제의식을 오늘의 일과 삶에 다시 연결하는 장면에서 시작',
    topic_key_questions: [
      `${title}가 지금 어떤 독자에게 유효한가`,
      '핵심 주장이나 장면을 실무와 삶의 판단 기준으로 어떻게 번역할 수 있는가',
      '읽고 난 뒤 바로 적용할 수 있는 질문은 무엇인가',
    ],
    topic_closing_angle: '책 소개를 넘어서 독자의 다음 행동과 질문으로 연결하며 마무리',
    topic_freshness_summary: `도서명 "${title}"과 핵심 질문을 제목/서론에서 명확히 고정`,
  };
}

async function _resolveScheduledBookResearch(preparedResearch, scheduledBook, scheduleId = null) {

  if (scheduledBook?.book_title && scheduledBook?.book_isbn) {
    const duplicateBook = await _findExistingReviewedBook(scheduledBook);
    if (duplicateBook) {
      return {
        ok: false,
        skipped: true,
        reason: `기존 도서리뷰와 중복: ${scheduledBook.book_title}`,
      };
    }

    return {
      ok: true,
      researchData: {
        ...preparedResearch,
        book_info: {
          title: scheduledBook.book_title,
          author: scheduledBook.book_author || '',
          isbn: scheduledBook.book_isbn,
          source: 'schedule',
        },
        ..._buildBookReviewTopicMeta({
          title: scheduledBook.book_title,
          author: scheduledBook.book_author || '',
        }),
      },
    };
  }

  if (!scheduledBook?.book_title) {
    return { ok: true, researchData: preparedResearch };
  }

  console.log(`[젬스] 스케줄 도서 ISBN 없음 → 검색으로 보완: ${scheduledBook.book_title}`);
  const book = await blogSkills.bookReviewBook.resolveBookForReview({ topic: scheduledBook.book_title });
  if (!book) {
    return {
      ok: false,
      skipped: true,
      reason: '도서 검색/선택/검증 실패',
    };
  }

  await _updateScheduledBookInfo(scheduleId, book);
  await _markBookReviewQueueStatus(book, 'selected', { note: 'scheduled_book_selected' });
  return {
    ok: true,
    researchData: {
      ...preparedResearch,
      book_info: book,
      ..._buildBookReviewTopicMeta(book),
    },
  };
}

async function _resolveDynamicBookResearch(preparedResearch, researchData, scheduleId = null) {
  const skillInput = await _buildBookReviewSkillInput(researchData);
  console.log(`[젬스] 도서리뷰 주제 선정: ${skillInput.topic}`);
  const book = await blogSkills.bookReviewBook.resolveBookForReview(skillInput);
  if (!book) {
    return {
      ok: false,
      skipped: true,
      reason: '도서 검색/선택/검증 실패',
    };
  }

  await _updateScheduledBookInfo(scheduleId, book);
  await _markBookReviewQueueStatus(book, 'selected', { note: 'dynamic_book_selected' });
  return {
    ok: true,
    researchData: {
      ...preparedResearch,
      book_info: book,
      ..._buildBookReviewTopicMeta(book),
    },
  };
}

async function _prepareBookReviewResearch(preparedResearch, researchData, scheduledBook, scheduleId = null) {
  if (scheduledBook?.book_title || scheduledBook?.book_isbn) {
    return _resolveScheduledBookResearch(preparedResearch, scheduledBook, scheduleId);
  }

  try {
    return await _resolveDynamicBookResearch(preparedResearch, researchData, scheduleId);
  } catch (error) {
    return {
      ok: false,
      skipped: true,
      reason: `도서 정보 수집/검증 실패: ${error.message}`,
    };
  }
}

// ─── 스키마 초기화 ────────────────────────────────────────────────────

async function ensureSchema() {
  try {
    await ensureBlogCoreSchema();
  } catch (error) {
    if (String(error?.code || '').trim() === 'EPERM') {
      console.log('[블로] DB 접근 제한 — 스키마 자동 보강 생략');
      return;
    }
    console.warn('[블로] 스키마 자동 보강 실패:', error?.message || error);
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
      SELECT id, title, metadata->>'filename' AS filename, metadata
      FROM blog.posts
      WHERE status = 'published'
        AND COALESCE(NULLIF(metadata->>'exclude_from_reference', '')::boolean, false) = false
        AND metadata->>'filename' = ANY($1::text[])
    `, [filenames]);
    const publishedSet = new Set(
      rows
        .filter((row) => !isExcludedReferencePost(row))
        .map((row) => String(row.filename || '').trim())
        .filter(Boolean),
    );
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

function _hasLectureSection(content, sectionTitle) {
  const text = String(content || '');
  if (!text) return false;
  if (text.includes(`[${sectionTitle}]`)) return true;
  const headingPattern = new RegExp(`<h2[^>]*class="section-title"[^>]*>\\s*${String(sectionTitle).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*<\\/h2>`, 'i');
  return headingPattern.test(text);
}

function _buildLectureHashtagLine(lectureTitle = '') {
  const tokens = String(lectureTitle || '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 8);
  const tagSet = new Set([
    '#Nodejs',
    '#Node강의',
    '#백엔드개발',
    '#실무강의',
    '#웹개발',
    '#스터디카페',
    '#커피랑도서관',
    '#분당서현점',
    '#개발공부',
    '#프로그래밍',
    '#개발자학습',
    '#승호아빠',
  ]);
  for (const token of tokens) {
    tagSet.add(`#${token.replace(/\s+/g, '')}`);
  }
  return Array.from(tagSet).slice(0, 22).join(' ');
}

function _ensureLectureClosingFloor(post, context) {
  const content = String(post?.content || '').trim();
  if (!content) return post;

  let next = content;
  const lectureTitle = context?.lectureTitle || '이번 강의';
  const lectureNumber = Number(context?.number || 0);
  const nextLecture = lectureNumber > 0 ? `${lectureNumber + 1}강` : '다음 강의';
  const relatedPosts = Array.isArray(context?.researchData?.relatedPosts)
    ? context.researchData.relatedPosts
    : [];

  if (!_hasLectureSection(next, '마무리 인사')) {
    next = `${next}\n\n[마무리 인사]\n오늘 ${lectureNumber || ''}강에서는 ${lectureTitle}를 실무 흐름으로 다시 정리해봤습니다. 여기서 구조와 기준을 먼저 잡아두면 실제 구현 단계에서 흔들리는 시간을 꽤 줄일 수 있습니다. 다음 ${nextLecture}에서는 이번 흐름을 이어서 더 안전하게 운영하는 방법까지 연결해보겠습니다. 승호아빠도 같은 포인트를 현업에서 자주 다시 확인하게 됩니다.`.trim();
  }

  if (!_hasLectureSection(next, '함께 읽으면 좋은 글')) {
    const relatedLines = relatedPosts.length > 0
      ? relatedPosts.slice(0, 3).map((item) => `- ${item.title}`).join('\n')
      : [
        `- [Node.js ${Math.max(1, lectureNumber - 1)}강] 이전 흐름 복습 포인트`,
        `- ${lectureTitle}와 연결되는 실무 아키텍처 점검 글`,
        '- 운영 장애를 줄이는 백엔드 설계 체크리스트',
      ].join('\n');
    next = `${next}\n\n[함께 읽으면 좋은 글]\n${relatedLines}`.trim();
  }

  if (!_hasLectureSection(next, '해시태그')) {
    next = `${next}\n\n[해시태그]\n${_buildLectureHashtagLine(lectureTitle)}`.trim();
  }

  if (next === content) return post;
  return {
    ...post,
    content: next,
    charCount: next.length,
  };
}

async function _runQualityRepair(kind, context, draft, variation, repairFn) {
  let post = kind === 'lecture' ? _ensureLectureClosingFloor(draft, context) : draft;
  let quality = await checkQualityEnhanced(post.content, kind, {
    lectureNumber: kind === 'lecture' ? context.number : null,
    expectedLectureTitle: kind === 'lecture' ? context.lectureTitle : null,
    category: kind === 'general' ? context.category : null,
    bookInfo: kind === 'general' ? context.book_info || context.data?.book_info || null : null,
    topicTitleCandidate: kind === 'general' ? context.researchData?.topic_title_candidate || null : null,
    expectedTitlePattern: kind === 'general'
      ? context.researchData?.strategy_preferred_pattern || null
      : null,
  });
  _logQualityResult(quality, post.charCount);

  for (let attempt = 0; attempt < 2 && (!quality.passed || quality.autoRewriteRecommended); attempt += 1) {
    console.log(`[품질] 초안 보정 시도... (${attempt + 1}/2)`);
    const retry = await repairFn(context, post, quality, variation);
    const repaired = kind === 'lecture' ? _ensureLectureClosingFloor(retry, context) : retry;
    const retryQuality = await checkQualityEnhanced(repaired.content, kind, {
      lectureNumber: kind === 'lecture' ? context.number : null,
      expectedLectureTitle: kind === 'lecture' ? context.lectureTitle : null,
      category: kind === 'general' ? context.category : null,
      bookInfo: kind === 'general' ? context.book_info || context.data?.book_info || null : null,
      topicTitleCandidate: kind === 'general' ? context.researchData?.topic_title_candidate || null : null,
      expectedTitlePattern: kind === 'general'
        ? context.researchData?.strategy_preferred_pattern || null
        : null,
    });
    post = repaired;
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

function _attachQualitySummary(result, quality) {
  return {
    ...result,
    qualityPassed: quality?.passed,
    qualityScore: Number(quality?.score || (quality?.passed ? 8 : 5)),
  };
}

function _buildSenseSummary(sense = null) {
  if (!sense) return null;
  return {
    sensedAt: sense.sensedAt || null,
    signalCount: Array.isArray(sense.signals) ? sense.signals.length : 0,
    signalTypes: Array.isArray(sense.signals) ? sense.signals.map((signal) => signal.type).filter(Boolean).slice(0, 8) : [],
    skaRevenueRatio: Number(sense?.skaRevenue?.ratio || 0),
    skaRevenueTrend: sense?.skaRevenue?.trend || null,
    blogAvgViews: Number(sense?.blogPerformance?.avgViews || 0),
  };
}

function _buildRevenueSummary(correlation = null) {
  if (!correlation) return null;
  return {
    period: Number(correlation.period || 0),
    revenueImpact: Number(correlation.revenueImpact || 0),
    revenueImpactPct: Number(correlation.revenueImpactPct || 0),
    highViewRevenueAfter: Number(correlation.highViewRevenueAfter || 0),
  };
}

async function _decideAutonomyForPost(postData, daily = {}, quality = null) {
  try {
    const strategyPlan = loadLatestStrategy() || {};
    const operationalPatterns = Array.isArray(strategyPlan?.operationalLearning?.patterns)
      ? strategyPlan.operationalLearning.patterns
      : [];
    const lanePattern = operationalPatterns.find((item) => String(item?.type || '') === 'ops_autonomy_lane') || null;
    const laneSummary = String(lanePattern?.summary || '');
    const runtimeContext = {
      signalCount: Number(daily?.senseState?.signals?.length || 0),
      topSignalType: String(daily?.senseState?.signals?.[0]?.type || ''),
      revenueImpactPct: Number(daily?.revenueCorrelation?.revenueImpactPct || 0),
      guardedDominant: laneSummary.includes('auto_publish_guarded'),
    };
    const decision = await decideAutonomy(postData, {
      seoScore: quality?.seo?.seoScore,
      criticScore: quality?.critic?.criticScore,
    }, runtimeContext);
    return {
      ...decision,
      senseSummary: _buildSenseSummary(daily.senseState),
      revenueSummary: _buildRevenueSummary(daily.revenueCorrelation),
      runtimeContext,
    };
  } catch (error) {
    console.warn('[블로] autonomy 판단 실패 (무시):', error.message);
    return null;
  }
}

async function _recordAutonomyDecision(postData, autonomy = null, extra = {}) {
  if (!autonomy || DEV_HUB_READONLY) return;

  try {
    await pgPool.run('blog', `
      INSERT INTO blog.autonomy_decisions
        (decision_date, post_type, category, title, post_id, autonomy_phase, decision, score, threshold, reasons, sense_summary, revenue_summary, metadata)
      VALUES
        (CURRENT_DATE, $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb)
    `, [
      postData.postType || 'general',
      postData.category || null,
      postData.title || '',
      postData.postId || null,
      Number(autonomy.phase || 1),
      autonomy.decision || 'auto_publish_guarded',
      Number(autonomy.score || 0),
      Number(autonomy.threshold || 0),
      JSON.stringify(Array.isArray(autonomy.reasons) ? autonomy.reasons : []),
      JSON.stringify(autonomy.senseSummary || {}),
      JSON.stringify(autonomy.revenueSummary || {}),
      JSON.stringify(extra || {}),
    ]);
  } catch (error) {
    console.warn('[블로] autonomy decision 기록 실패 (무시):', error.message);
  }
}

function _createLocalDraftRunner({
  kind,
  context,
  chunkedLabel,
  chunkedWriter,
  singleWriter,
  repairDraft,
  buildRepairContext,
  buildSingleArgs,
  buildChunkedArgs,
  buildRepairArgs,
}) {
  return async (variation) => {
    let post;
    const forceSinglePass = process.env.BLOG_FORCE_SINGLE_PASS === '1';
    try {
      if (forceSinglePass) {
        console.log(`[블로] ${chunkedLabel} 분할 생성 우회 — 단일 생성 강제`);
        post = await singleWriter(...buildSingleArgs(context, variation));
      } else {
        post = await chunkedWriter(...buildChunkedArgs(context, variation));
      }
    } catch (e) {
      console.warn(`[블로] ${chunkedLabel} 분할 생성 실패 — 단일 생성 폴백:`, e.message);
      post = await singleWriter(...buildSingleArgs(context, variation));
    }

    return _runQualityRepair(
      kind,
      buildRepairContext(context),
      post,
      variation,
      async (repairContext, currentPost, quality) => repairDraft(...buildRepairArgs(repairContext, currentPost, quality, variation))
    );
  };
}

async function _createInstaContentSafe(content, title, category, label, options = {}) {
  if (process.env.BLOG_INSTA_ENABLED === 'false') return null;
  const strategy = options.strategy || loadLatestStrategy();
  const directives = normalizeExecutionDirectives(strategy);
  const instagramPriority = directives.channelPriority.instagram;
  const dynamicCardCount = instagramPriority === 'primary' ? 5 : instagramPriority === 'secondary' ? 4 : 3;
  const instaContent = await createInstaContent(content, title, category, dynamicCardCount, { ...options, strategy }).catch(e => {
    console.warn(`[소셜] ${label} 생성 실패 (무시):`, e.message);
    return null;
  });
  if (instaContent) {
    console.log(`[소셜] ${label} 완료: 릴스 ${instaContent.reel ? '1개' : '0개'} + 해시태그 ${instaContent.hashtags?.length}개`);
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

function _buildAccumulationOptions(traceCtx, options = {}, published = null) {
  return {
    traceId: traceCtx.trace_id,
    dryRun: !!options.dryRun,
    reused: !!published?.reused,
  };
}

async function _accumulatePublishedPost(postData, quality, traceCtx, options = {}, published = null) {
  await accumulatePostExperience(postData, quality, _buildAccumulationOptions(traceCtx, options, published));
}

async function _recordPublishedExperiment(postData = {}, published = null) {
  if (!published?.postId || published?.reused) return;

  try {
    await recordPublishedExperimentRun({
      id: published.postId,
      post_type: postData.postType || 'general',
      category: postData.category || null,
      title: postData.title || '',
      metadata: postData.metadata || {},
      views: 0,
      comments: 0,
      likes: 0,
      published_at: new Date().toISOString(),
    });
  } catch (error) {
    console.warn('[블로] experiment run 기록 실패 (무시):', error.message);
  }
}

async function _advanceContentTracker({
  dryRun = false,
  published = null,
  skipLabel = '',
  dryRunLabel = '',
  readonlyLabel = '',
  advance,
}) {
  if (!dryRun && !published?.reused && !DEV_HUB_READONLY) {
    await advance();
    return;
  }

  if (published?.reused) {
    console.log(skipLabel);
  } else if (dryRun) {
    console.log(dryRunLabel);
  } else {
    console.log(readonlyLabel);
  }
}

function _buildPreparedContext(context) {
  return {
    skipped: false,
    context,
  };
}

function _buildSkippedPostResult(type, reason, extra = {}) {
  return {
    skipped: true,
    result: {
      type,
      skipped: true,
      reason,
      ...extra,
    },
  };
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
      return _buildSkippedPostResult('lecture', '시리즈 완료 — 차기 준비 중');
    }
    console.log(`[블로] 🔄 시리즈 전환 완료 → ${next.series_name} 1강부터 시작`);
    return _buildSkippedPostResult('lecture', `시리즈 전환: ${next.series_name}`);
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
  const strategyPlan = loadLatestStrategy() || {};
  const experimentPlaybook = readExperimentPlaybook() || null;
  const experimentDimensionKey = experimentPlaybook?.topWinner?.dimension === 'title_pattern'
    ? 'titlePattern'
    : experimentPlaybook?.topWinner?.dimension === 'autonomy_lane'
      ? 'autonomyLane'
      : 'category';
  const experimentLoser = experimentPlaybook?.dimensions?.[experimentDimensionKey]?.loser || null;
  preparedResearch.strategy_experiment_winner = strategyPlan?.experimentLearning?.topWinnerSummary
    || (
      experimentPlaybook?.topWinner?.variant
        ? `최근 실험 승자는 ${experimentPlaybook.topWinner.dimension}:${experimentPlaybook.topWinner.variant} (${Math.round(Number(experimentPlaybook.topWinner.liftPct || 0) * 100)}% lift, n=${experimentPlaybook.topWinner.sampleCount}) 입니다.`
        : ''
    );
  preparedResearch.strategy_experiment_weak_lane = strategyPlan?.experimentLearning?.weakestVariantSummary
    || (
      experimentLoser?.variant
        ? `최근 약한 레인은 ${experimentLoser.dimension}:${experimentLoser.variant} (${Math.round(Number(experimentLoser.liftPct || 0) * 100)}% lift, n=${experimentLoser.sampleCount}) 입니다.`
        : ''
    );
  const pastPosts = await searchPastPosts(lectureTitle);
  if (pastPosts.length > 0) {
    console.log(`[블로] 유사 과거 포스팅 ${pastPosts.length}건 발견 — 차별화 데이터 포함`);
    preparedResearch.pastPosts = pastPosts;
  }

  return _buildPreparedContext({
    number,
    seriesName,
    lectureTitle,
    sectionVariation,
    researchData: preparedResearch,
  });
}

async function _prepareGeneralContext(researchData, traceCtx, preloaded = {}, scheduleId = null, dailyState = {}, lunaRequest = null, options = {}) {
  const { category } = preloaded.category ? preloaded : { category: '자기계발' };
  const sectionVariation = preloaded.sectionVariation || {};
  const needsBook = category === '도서리뷰';
  const strategyPlan = loadLatestStrategy();

  console.log(`\n[젬스] 일반 포스팅: ${category}`);
  const writeReq = createMessage('task_request', 'blog-blo', 'blog-gems', {
    category,
    traceId: traceCtx.trace_id,
  });
  console.log(`[블로] MessageEnvelope → 젬스 (${writeReq.message_id.slice(0, 8)})`);

  let preparedResearch = { ...researchData };
  let usedLunaRequestId = null;
  if (preloaded.topicHint) {
    preparedResearch.topic_hint = String(preloaded.topicHint).trim();
  }
  if (!needsBook && !preparedResearch.topic_hint) {
    // 0순위: 루나 요청 앵글 합성 (있을 때만)
    if (lunaRequest) {
      try {
        const recentPosts = getRecentPosts(category, 10);
        const hybridTopic = synthesizeHybridTopic(category, lunaRequest, recentPosts, strategyPlan);
        if (hybridTopic) {
          console.log(`[젬스] 루나 하이브리드 주제 선택: ${hybridTopic.title} (regime=${lunaRequest.regime})`);
          preparedResearch = {
            ...preparedResearch,
            topic_hint: hybridTopic.topic,
            topic_question: hybridTopic.question,
            topic_diff: hybridTopic.diff,
            topic_title_candidate: hybridTopic.title,
            topic_reader_problem: hybridTopic.readerProblem || '',
            topic_opening_angle: hybridTopic.openingAngle || '',
            topic_key_questions: Array.isArray(hybridTopic.keyQuestions) ? hybridTopic.keyQuestions : [],
            topic_closing_angle: hybridTopic.closingAngle || '',
            topic_freshness_summary: hybridTopic.freshnessSummary || '',
            topic_marketing_signal_summary: hybridTopic.marketingSignalSummary || '',
            topic_marketing_recommendations: hybridTopic.marketingRecommendations || [],
            topic_marketing_cta_hint: hybridTopic.marketingCtaHint || '',
            strategy_focus: [],
            strategy_recommendations: [],
            strategy_preferred_pattern: hybridTopic.pattern || null,
            strategy_suppressed_pattern: null,
          };
          usedLunaRequestId = lunaRequest.id;
        } else {
          console.log(`[젬스] 루나 하이브리드 주제 품질 게이트 실패 — 기본 로테이션으로 폴백 (regime=${lunaRequest.regime})`);
          await _skipLunaRequest(lunaRequest.id, `${category}×${lunaRequest.regime} 합성 실패`);
        }
      } catch (error) {
        console.warn('[젬스] 루나 하이브리드 주제 합성 실패 — 기본 로테이션 유지:', error.message);
      }
    }
    // 루나 앵글 없거나 품질 게이트 실패 시: 기존 로테이션
    if (!preparedResearch.topic_hint) {
      try {
        const plannedTopic = await _selectGeneralTopicForRun(category, strategyPlan, dailyState, {
          dryRun: options.dryRun === true,
          targetDate: _getBlogRunDate(),
          itNews: Array.isArray(preparedResearch.it_news) ? preparedResearch.it_news : [],
        });
        preparedResearch = _applyGeneralTopicStrategy(preparedResearch, category, strategyPlan, dailyState, plannedTopic);
        const selectedTopic = preparedResearch._selectedTopic;
        console.log(`[젬스] 주제 선택: ${selectedTopic.title}${selectedTopic.source ? ` (${selectedTopic.source})` : ''}${selectedTopic.forced ? ' (forced)' : ''}`);
        delete preparedResearch._selectedTopic;
      } catch (error) {
        console.warn('[젬스] 주제 다양화 선택 실패 — 기본 자율 주제 유지:', error.message);
      }
    }
  }
  if (needsBook) {
    const bookResult = await _prepareBookReviewResearch(preparedResearch, researchData, preloaded.bookInfo, scheduleId);
    if (!bookResult.ok) {
      console.warn(`[젬스] ${bookResult.reason} — 도서리뷰 스킵`);
      return _buildSkippedPostResult('general', bookResult.reason, {
        category,
        sectionVariation,
      });
    }
    preparedResearch = bookResult.researchData;
    if (preparedResearch.book_info?.title) {
      console.log(`[젬스] 도서 정보 준비 완료: ${preparedResearch.book_info.title}`);
    }
  }

  return _buildPreparedContext({
    category,
    sectionVariation,
    researchData: preparedResearch,
    book_info: preparedResearch.book_info || null,
    topicHint: preparedResearch.topic_hint || null,
    topicQuestion: preparedResearch.topic_question || null,
    topicDiff: preparedResearch.topic_diff || null,
    topicSelection: {
      source: preparedResearch.topic_selection_source || null,
      id: preparedResearch.topic_selection_id || null,
      targetDate: preparedResearch.topic_selection_target_date || null,
    },
    strategyPlan,
    usedLunaRequestId,
  });
}

async function _finalizeLecturePost(post, quality, context, scheduleId, traceCtx, writerName = null, options = {}) {
  const postTitle = `[Node.js ${context.number}강] ${context.lectureTitle}`;
  const autonomy = await _decideAutonomyForPost({
    title: postTitle,
    content: post.content,
    thumbnailPath: null,
    postType: 'lecture',
    category: 'Node.js강의',
  }, context.daily || {}, quality);
  const published = await _publishAndTrack({
    title:         postTitle,
    content:       post.content,
    category:      'Node.js강의',
    postType:      'lecture',
    lectureNumber: context.number,
    charCount:     post.charCount,
    writerName,
    scheduleId,
    metadata: autonomy ? { autonomy } : undefined,
  }, scheduleId, traceCtx, {
    type: 'lecture',
    number: context.number,
    title: context.lectureTitle,
    charCount: post.charCount,
  }, options);
  await _recordPublishedExperiment({
    postType: 'lecture',
    category: 'Node.js강의',
    title: postTitle,
    metadata: autonomy ? { autonomy } : {},
  }, published);

  await _accumulatePublishedPost({
    title: postTitle,
    content: post.content,
    category: 'Node.js강의',
    postType: 'lecture',
    writerName,
    charCount: post.charCount,
    postId: published.postId || null,
    scheduleId,
  }, quality, traceCtx, options, published);

  await _recordAutonomyDecision({
    title: postTitle,
    category: 'Node.js강의',
    postType: 'lecture',
    postId: published.postId || null,
  }, autonomy, {
    trace_id: traceCtx.trace_id,
    writer_name: writerName || null,
    lecture_number: context.number,
  });

  await _advanceContentTracker({
    dryRun: !!options.dryRun,
    published,
    skipLabel: `[블로] 강의 ${context.number}강 재실행 감지 — 인덱스 증가 생략`,
    dryRunLabel: `[블로][dry-run] 강의 인덱스 증가 생략 (${context.number}강)`,
    readonlyLabel: `[블로] DEV/HUB 읽기 전용 — 강의 인덱스 증가 생략 (${context.number}강)`,
    advance: advanceLectureNumber,
  });

  const instaContent = options.dryRun
    ? null
    : await _createInstaContentSafe(
      post.content,
      postTitle,
      'Node.js강의',
      '강의 인스타',
      { thumbPath: null }
    );

  const instagramQuotaAvailable = options.dryRun ? true : await hasRemainingPublishQuota('instagram').catch(() => true);
  const instaCrosspost = instaContent?.reel?.outputPath && instagramQuotaAvailable
    ? await crosspostToInstagram(instaContent, postTitle, published.postId, !!options.dryRun).catch(e => {
      console.warn('[크로스포스트] 강의 처리 중 예외:', e.message);
      return { ok: false, error: e.message };
    })
    : (instaContent?.reel?.outputPath ? { ok: false, skipped: true, reason: 'instagram_strategy_quota_reached' } : null);

  return {
    type:           'lecture',
    number:         context.number,
    title:          context.lectureTitle,
    instaContent:   instaContent || null,
    instaCrosspost: instaCrosspost || null,
    charCount:      post.charCount,
    quality:        quality.passed,
    aiRisk:         quality.aiRisk,
    filename:       published.filename,
    postId:         published.postId,
    dryRun:         !!options.dryRun,
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

  // 루나 요청 유래 포스트만 투자 가드레일 적용
  if (context.usedLunaRequestId) {
    const guard = checkInvestmentContent(post.content || '', genTitle);
    if (!guard.passed) {
      console.error('[블로/investment-guard] 투자 콘텐츠 가드 실패:', guard.warnings);
      await _skipLunaRequest(context.usedLunaRequestId, `투자 가드 실패: ${guard.warnings.join(', ')}`);
      throw new Error(`투자 콘텐츠 가드 실패: ${guard.warnings.join(', ')}`);
    }
    if (guard.mustAdd.length > 0) {
      post.content = (post.content || '') + guard.mustAdd.join('\n');
    }
  }
  const images = options.dryRun
    ? null
    : await generatePostImages({ title: genTitle, postType: 'general', category: context.category }).catch(async e => {
      console.error('[이미지] 생성 실패 (일반):', e.message);
      await reportImageGenFailure(genTitle, e.message);
      const diag = await diagnoseImageGeneration();
      if (!diag.healthy) await reportImageDiagnosis(diag.issues);
      console.log('[이미지] 일반 포스팅은 이미지 없이 발행 계속 진행');
      return null;
    });

  const instaContent = options.dryRun
    ? null
    : await _createInstaContentSafe(
      post.content,
      genTitle,
      context.category,
      '인스타',
      { thumbPath: images?.thumb?.filepath || null }
    );

  const autonomy = await _decideAutonomyForPost({
    title: genTitle,
    content: post.content,
    thumbnailPath: images?.thumb?.filepath || null,
    postType: 'general',
    category: context.category,
  }, context.daily || {}, quality);
  const titleAlignment = _buildGeneralTitleAlignmentMetadata({
    ...post,
    title: genTitle,
  }, context);
  const metadata = {};
  if (autonomy) metadata.autonomy = autonomy;
  if (titleAlignment?.preview_title || titleAlignment?.final_title) {
    metadata.title_alignment = titleAlignment;
  }

  const published = await _publishAndTrack({
    title:     genTitle,
    content:   post.content,
    category:  context.category,
    postType:  'general',
    charCount: post.charCount,
    writerName,
    images,
    scheduleId,
    metadata: Object.keys(metadata).length ? metadata : undefined,
  }, scheduleId, traceCtx, {
    type: 'general',
    category: context.category,
    title: post.title,
    charCount: post.charCount,
  }, options);
  await _recordPublishedExperiment({
    postType: 'general',
    category: context.category,
    title: genTitle,
    metadata,
  }, published);

  await _accumulatePublishedPost({
    title: genTitle,
    content: post.content,
    category: context.category,
    postType: 'general',
    writerName,
    charCount: post.charCount,
    postId: published.postId || null,
    scheduleId,
  }, quality, traceCtx, options, published);

  await _recordAutonomyDecision({
    title: genTitle,
    category: context.category,
    postType: 'general',
    postId: published.postId || null,
  }, autonomy, {
    trace_id: traceCtx.trace_id,
    writer_name: writerName || null,
    topic_hint: context.topicHint || null,
  });

  if (context.category === '도서리뷰' && context.book_info && !options.dryRun) {
    await blogSkills.bookReviewBook.updateBookCatalogEntry({
      isbn: context.book_info.isbn || null,
      title: context.book_info.title || null,
      reviewed: true,
    }).catch((error) => {
      console.warn('[블로] book_catalog reviewed 마킹 실패:', error.message);
    });

    await _markBookReviewQueueStatus(context.book_info, 'done', {
      postId: published.postId || null,
      note: 'book_review_published',
    });
    await _refillBookReviewQueue(5);
  }

  await _advanceContentTracker({
    dryRun: !!options.dryRun,
    published,
    skipLabel: `[블로] 일반 포스팅 재실행 감지 (${context.category}) — 카테고리 증가 생략`,
    dryRunLabel: `[블로][dry-run] 일반 카테고리 증가 생략 (${context.category})`,
    readonlyLabel: `[블로] DEV/HUB 읽기 전용 — 일반 카테고리 증가 생략 (${context.category})`,
    advance: advanceGeneralCategory,
  });

  const instagramQuotaAvailable = options.dryRun ? true : await hasRemainingPublishQuota('instagram').catch(() => true);
  const instaCrosspost = instaContent?.reel?.outputPath && instagramQuotaAvailable
    ? await crosspostToInstagram(instaContent, genTitle, published.postId, !!options.dryRun).catch(e => {
      console.warn('[크로스포스트] 일반 처리 중 예외:', e.message);
      return { ok: false, error: e.message };
    })
    : (instaContent?.reel?.outputPath ? { ok: false, skipped: true, reason: 'instagram_strategy_quota_reached' } : null);

  return {
    type:           'general',
    category:       context.category,
    title:          post.title || `[${context.category}]`,
    charCount:      post.charCount,
    quality:        quality.passed,
    aiRisk:         quality.aiRisk,
    filename:       published.filename,
    postId:         published.postId,
    instaContent:   instaContent || null,
    instaCrosspost: instaCrosspost || null,
    dryRun:         !!options.dryRun,
  };
}

async function _expireOldRequests() {
  try {
    const result = await pgPool.run('blog', `
      UPDATE blog.content_requests
      SET status = 'expired'
      WHERE status = 'pending' AND expires_at <= NOW()
      RETURNING id
    `);
    const count = result?.rowCount || 0;
    if (count > 0) {
      console.log(`[블로/content_requests] ${count}건 만료 처리`);
    }
  } catch (err) {
    console.warn('[블로/content_requests] 만료 처리 실패 (무시):', err.message);
  }
}

async function _prepareDailyRun(traceCtx, options = {}) {
  await ensureSchema();
  await _expireOldRequests();

  const config = await getConfig();
  if (!config.active) {
    return { inactive: true, results: [] };
  }

  console.log(`[블로] 오늘 생성 목표: 강의 ${config.lecture_count}편 + 일반 ${config.general_count}편`);

  const scheduleContext = await getTodayContext({
    preserveScheduledGeneralCategory: options.generalOnly === true,
  });
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

  if (options.dryRun && options.phase1FastDryRun) {
    console.log('[블로][phase1-fast-dry-run] 리서치/작성/이미지 단계를 건너뛰고 스케줄 구조만 점검');
    return {
      inactive: false,
      complete: false,
      phase1FastDryRun: true,
      config,
      researchData: {},
      senseState: null,
      revenueCorrelation: null,
      ...scheduleContext,
    };
  }

  const [senseState, revenueCorrelation, attributionCategoryWeights] = await Promise.all([
    senseDailyState().catch((error) => {
      console.warn('[블로] sense-engine 실패 (무시):', error.message);
      return null;
    }),
    analyzeMarketingToRevenue(14).catch((error) => {
      console.warn('[블로] revenue-correlation 실패 (무시):', error.message);
      return null;
    }),
    fetchRevenueAttributionWeights().catch(() => ({})),
  ]);

  const researchData = await collectAllResearch('general', false);

  const lunaRequest = await getPendingLunaRequest().catch((error) => {
    console.warn('[블로] 루나 요청 조회 실패 (무시):', error.message);
    return null;
  });
  if (lunaRequest) {
    console.log(`[블로] 루나 콘텐츠 요청 감지: regime=${lunaRequest.regime}, urgency=${lunaRequest.urgency}`);
  }

  return {
    inactive: false,
    complete: false,
    config,
    researchData,
    senseState,
    revenueCorrelation,
    attributionCategoryWeights,
    lunaRequest,
    ...scheduleContext,
  };
}

function _buildPhase1FastLectureResult(lectureCtx, options = {}) {
  return {
    type: 'lecture',
    number: lectureCtx.number,
    title: `[Phase1 Fast Dry-Run] ${lectureCtx.lectureTitle}`,
    charCount: 0,
    quality: true,
    aiRisk: {
      riskLevel: 'low',
      riskScore: 0,
      note: 'phase1_fast_dry_run',
    },
    dryRun: !!options.dryRun,
    fastDryRun: true,
  };
}

function _buildPhase1FastGeneralResult(generalCtx, options = {}) {
  const previewTitle = generalCtx?.book_info?.title
    || generalCtx?.topicHint
    || (generalCtx.category === '도서리뷰'
      ? '도서 후보/큐 연결 점검'
      : '카테고리 라우팅 점검');

  return {
    type: 'general',
    category: generalCtx.category,
    title: `[Phase1 Fast Dry-Run][${generalCtx.category}] ${previewTitle}`,
    charCount: 0,
    quality: true,
    aiRisk: {
      riskLevel: 'low',
      riskScore: 0,
      note: 'phase1_fast_dry_run',
    },
    dryRun: !!options.dryRun,
    fastDryRun: true,
  };
}

function _formatDailyResultLabel(result) {
  return result.type === 'lecture'
    ? `강의 ${result.number}강`
    : `일반[${result.category}]`;
}

function _formatDailyResultLine(result) {
  if (result.error) return `❌ ${result.type}: ${result.error.slice(0, 60)}`;
  if (result.skipped) return `⏭ ${result.type}: ${result.reason}`;
  return `${result.quality ? '✅' : '⚠️'} ${_formatDailyResultLabel(result)}: ${result.title?.slice(0, 30)} (${result.charCount}자)`;
}

function _buildDailyGuideLine(result) {
  return `${result.type === 'lecture' ? `[${result.number}강]` : `[${result.category}]`} ${_buildRewriteGuide(result.aiRisk)}`;
}

function _compactPreviewTitle(title = '', maxLength = 42) {
  const text = String(title || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'none';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function _summarizeDailyMarketing(daily = {}) {
  const senseState = daily?.senseState || {};
  const revenueCorrelation = daily?.revenueCorrelation || {};
  const strategyPlan = loadLatestStrategy() || {};
  const experimentPlaybook = readExperimentPlaybook() || null;
  const operationalPatterns = Array.isArray(strategyPlan?.operationalLearning?.patterns)
    ? strategyPlan.operationalLearning.patterns
    : [];
  const findOperationalSummary = (type) => {
    const item = operationalPatterns.find((pattern) => String(pattern?.type || '') === type);
    return item?.summary ? String(item.summary) : '';
  };
  const signal = senseState?.signals?.[0] || null;
  const signalLabel = signal?.message || (Array.isArray(senseState?.signals) && senseState.signals.length ? `${senseState.signals.length}개 신호 감지` : '특이 신호 없음');
  const revenueImpact = Number(revenueCorrelation?.revenueImpactPct || 0);
  const preferredCategory = strategyPlan?.preferredCategory || 'none';
  const preferredPattern = strategyPlan?.preferredTitlePattern || 'none';
  const suppressedPattern = strategyPlan?.suppressedTitlePattern || 'none';
  const opsTitlePatternSummary = findOperationalSummary('ops_high_performance_title_pattern');
  const opsAlignmentSummary = findOperationalSummary('ops_alignment_signal');
  const opsAutonomyLaneSummary = findOperationalSummary('ops_autonomy_lane');
  const experimentDimensionKey = experimentPlaybook?.topWinner?.dimension === 'title_pattern'
    ? 'titlePattern'
    : experimentPlaybook?.topWinner?.dimension === 'autonomy_lane'
      ? 'autonomyLane'
      : 'category';
  const experimentLoser = experimentPlaybook?.dimensions?.[experimentDimensionKey]?.loser || null;
  const experimentWinnerSummary = strategyPlan?.experimentLearning?.topWinnerSummary
    || (
      experimentPlaybook?.topWinner?.variant
        ? `최근 실험 승자는 ${experimentPlaybook.topWinner.dimension}:${experimentPlaybook.topWinner.variant} (${Math.round(Number(experimentPlaybook.topWinner.liftPct || 0) * 100)}% lift, n=${experimentPlaybook.topWinner.sampleCount}) 입니다.`
        : ''
    );
  const experimentWeakLaneSummary = strategyPlan?.experimentLearning?.weakestVariantSummary
    || (
      experimentLoser?.variant
        ? `최근 약한 레인은 ${experimentLoser.dimension}:${experimentLoser.variant} (${Math.round(Number(experimentLoser.liftPct || 0) * 100)}% lift, n=${experimentLoser.sampleCount}) 입니다.`
        : ''
    );
  const evalLatestSummary = String(strategyPlan?.evalLearning?.latestSummary || '');
  const evalRecurringSummary = String(strategyPlan?.evalLearning?.recurringCodeSummary || '');
  const dailyMixPrimaryCategory = String(strategyPlan?.dailyMixPolicy?.primaryCategory || '');
  const dailyMixTitlePattern = String(strategyPlan?.dailyMixPolicy?.titlePatternFocus || '');
  const dailyMixRotationMode = String(strategyPlan?.dailyMixPolicy?.rotationMode || '');
  const dailyMixStabilityMode = strategyPlan?.dailyMixPolicy?.stabilityMode === true;
  const nextGeneralCategory = daily?.generalCtx?.category || 'none';
  const selectedGeneralTopic = nextGeneralCategory !== 'none'
    ? selectAndValidateTopic(
      nextGeneralCategory,
      getRecentPosts(nextGeneralCategory, 10),
      strategyPlan,
      senseState,
      revenueCorrelation
    )
    : null;
  const nextGeneralTitle = selectedGeneralTopic?.title || 'none';
  const nextGeneralPattern = selectedGeneralTopic?.pattern || 'none';

  let predictedAdoption = 'warming_up';
  if (daily?.generalCtx?.category) {
    const categoryAligned = preferredCategory !== 'none' && nextGeneralCategory === preferredCategory;
    const patternAligned = preferredPattern !== 'none' && nextGeneralPattern === preferredPattern;
    predictedAdoption = categoryAligned && patternAligned
      ? 'aligned'
      : (categoryAligned || patternAligned)
        ? 'partial'
        : 'off_track';
  }

  return {
    signalLabel,
    revenueImpactPct: revenueImpact,
    preferredCategory,
    preferredPattern,
    suppressedPattern,
    nextGeneralCategory,
    nextGeneralTitle,
    nextGeneralPattern,
    predictedAdoption,
    opsTitlePatternSummary,
    opsAlignmentSummary,
    opsAutonomyLaneSummary,
    experimentWinnerSummary,
    experimentWeakLaneSummary,
    evalLatestSummary,
    evalRecurringSummary,
    dailyMixPrimaryCategory,
    dailyMixTitlePattern,
    dailyMixRotationMode,
    dailyMixStabilityMode,
    briefLine: `📈 마케팅 전략: signal=${signalLabel} | impact=${(revenueImpact * 100).toFixed(1)}% | plan=${preferredCategory}/${preferredPattern} | next=${nextGeneralCategory}/${nextGeneralPattern} | predicted=${predictedAdoption} | title=${_compactPreviewTitle(nextGeneralTitle)} | suppress=${suppressedPattern}`,
  };
}

function _buildDailyReportLines(results, traceCtx, daily = {}) {
  const marketing = _summarizeDailyMarketing(daily);
  const contract = buildDailyReportContract({
    traceId: traceCtx.trace_id,
    results,
    marketing,
  });
  return [
    `📝 [${contract.title}]`,
    ...contract.sections.flatMap((section) => [
      `■ ${section.title}`,
      ...(Array.isArray(section.lines) ? section.lines.map((line) => `  ${line}`) : []),
    ]),
    '',
    '■ 결과 상세',
    ...results.map(_formatDailyResultLine),
    '',
    '■ 리라이팅 가이드',
    ...results.filter(r => !r.error && !r.skipped).map(_buildDailyGuideLine),
    '',
    '📁 파일 위치: bots/blog/output/',
    '📅 예약 발행: 내일 오전 07:00',
  ].filter(Boolean);
}

async function _safeEvaluateContract(contractId, payload) {
  if (!contractId) return;
  try {
    await hiringContract.evaluate(contractId, payload, null);
  } catch (e) {
    console.warn('[shadow] evaluate 기록 실패 (무시):', e.message);
  }
}

function _attachWriterPersonas(sectionVariation = {}, writerName, postType) {
  return {
    ...sectionVariation,
    writerPersona: getWriterPersona(writerName, postType),
    editorPersona: pickEditorPersona(postType),
  };
}

async function _hireBlogWriterContract(writerName, description) {
  try {
    const contract = await hiringContract.hire(writerName, {
      team: 'blog',
      description,
      requirements: { quality_min: 7.0, min_chars: 9000 },
    });
    return contract.contractId || null;
  } catch (e) {
    console.warn('[shadow] hire 기록 실패 (무시):', e.message);
    return null;
  }
}

async function _executeWithWriterContract(traceCtx, startTime, contractId, runner) {
  try {
    const result = await withTrace(traceCtx, runner);
    await _safeEvaluateContract(contractId, {
      quality: Number(result?.qualityScore || (result?.qualityPassed ? 8 : 5)),
      char_count: result?.charCount || 0,
      duration_ms: Date.now() - startTime,
    });
    return result;
  } catch (error) {
    await _safeEvaluateContract(contractId, {
      quality: 0,
      duration_ms: Date.now() - startTime,
      hallucination: false,
    });
    throw error;
  }
}

async function _sendDailyReport(results, traceCtx, options = {}) {
  const hasErrors = results.some(r => r.error);
  const marketing = _summarizeDailyMarketing(options.daily || {});
  const reportLines = _buildDailyReportLines(results, traceCtx, options.daily || {});
  const reportContract = buildDailyReportContract({
    traceId: traceCtx.trace_id,
    results,
    marketing,
  });

  const reportEvent = buildReportEvent({
    from_bot: 'blog-blo',
    team: 'blog',
    event_type: 'report',
    alert_level: hasErrors ? 2 : 1,
    title: reportContract.title,
    summary: `trace ${traceCtx.trace_id.slice(0, 8)} | ${results.length}건`,
    sections: [
      ...reportContract.sections,
      {
        title: '결과 상세',
        lines: results.map(_formatDailyResultLine),
      },
      {
        title: '리라이팅 가이드',
        lines: results.filter(r => !r.error && !r.skipped).map(_buildDailyGuideLine),
      },
    ],
    footer: '파일 위치: bots/blog/output/ | 예약 발행: 내일 오전 07:00',
    payload: {
      title: reportContract.title,
      summary: `trace ${traceCtx.trace_id.slice(0, 8)} | ${results.length}건`,
      contract: reportContract,
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

function _buildVerifyResult(daily) {
  const marketing = _summarizeDailyMarketing(daily);
  return {
    type: 'verify',
    ok: true,
    dryRun: false,
    verifyOnly: true,
    lectureScheduled: !!daily.lectureCtx,
    generalScheduled: !!daily.generalCtx,
    lectureCount: Number(daily.config?.lecture_count || 0),
    generalCount: Number(daily.config?.general_count || 0),
    marketing,
  };
}

function _applyRagContext(researchData, ragContext) {
  researchData.realExperiences = ragContext.episodes;
  researchData.relatedPosts = ragContext.relatedPosts;
  researchData.ragQuality = ragContext.quality;
}

async function _runLectureStage(daily, traceCtx, options = {}) {
  const { config, researchData, lectureCtx, lectureSchedule } = daily;
  if (!lectureCtx || config.lecture_count <= 0) return null;

  if (options.dryRun && options.phase1FastDryRun) {
    return _buildPhase1FastLectureResult(lectureCtx, options);
  }

  try {
    return await _runWithStageRetry('강의 포스팅', async () => {
      if (await isSeriesComplete()) {
        return { type: 'lecture', skipped: true, reason: '시리즈 완료' };
      }

      const { number, seriesName, lectureTitle } = lectureCtx;
      const ragContext = await agenticSearch(lectureTitle, 'lecture', 3, number);
      _applyRagContext(researchData, ragContext);

      if (lectureSchedule?.id && !options.dryRun) await updateScheduleStatus(lectureSchedule.id, 'writing');
      if (!options.dryRun) await prepareCompetition(lectureTitle, 'lecture');

      return await runLecturePost(researchData, traceCtx, {
        number, seriesName, lectureTitle,
      }, lectureSchedule?.id, options, daily);
    }, {
      maxAttempts: options?.dryRun ? 1 : 2,
      retryDelayMs: 5000,
    });
  } catch (e) {
    console.error('[블로] 강의 포스팅 실패:', e.message);
    if (lectureSchedule?.id && !options.dryRun) {
      await updateScheduleStatus(lectureSchedule.id, 'scheduled');
    }
    await _emitEvent('post_failed', { type: 'lecture', error: e.message, traceId: traceCtx.trace_id });
    return { type: 'lecture', error: e.message };
  }
}

async function _runGeneralStage(daily, traceCtx, options = {}) {
  const { config, researchData, generalCtx } = daily;
  if (!generalCtx || config.general_count <= 0) return null;

  if (options.dryRun && options.phase1FastDryRun) {
    const prepared = await _prepareGeneralContext(researchData, traceCtx, generalCtx, generalCtx.scheduleId, daily, null, options);
    if (prepared?.skipped) {
      return prepared.result || { type: 'general', skipped: true, reason: 'skipped' };
    }
    return _buildPhase1FastGeneralResult(prepared.context, options);
  }

  const { category, scheduleId, bookInfo } = generalCtx;
  try {
    const ragContext = await agenticSearch(category, 'general', 3);
    _applyRagContext(researchData, ragContext);

    if (scheduleId && !options.dryRun) await updateScheduleStatus(scheduleId, 'writing');
    if (!options.dryRun) await prepareCompetition(category, 'general');

    return await runGeneralPost(researchData, traceCtx, {
      category,
      bookInfo,
    }, scheduleId, options, daily, daily.lunaRequest || null);
  } catch (e) {
    console.error('[블로] 일반 포스팅 실패:', e.message);
    if (scheduleId && !options.dryRun) {
      await updateScheduleStatus(scheduleId, 'scheduled');
    }
    await _emitEvent('post_failed', { type: 'general', error: e.message, traceId: traceCtx.trace_id });
    return { type: 'general', error: e.message };
  }
}

async function _runPostPublishChecks(options = {}) {
  if (!options.dryRun) {
    await dailyCurriculumCheck().catch(e =>
      console.warn('[블로] 커리큘럼 체크 실패 (무시):', e.message)
    );
    return;
  }
  console.log('[블로][dry-run] 커리큘럼 체크 생략');
}

// ─── 강의 포스팅 ──────────────────────────────────────────────────────

async function runLecturePost(researchData, traceCtx, preloaded = {}, scheduleId = null, options = {}, dailyState = {}) {
  const prepared = await _prepareLectureContext(researchData, traceCtx, preloaded);
  if (prepared.skipped) return prepared.result;
  const context = prepared.context;
  context.daily = {
    senseState: dailyState.senseState || null,
    revenueCorrelation: dailyState.revenueCorrelation || null,
  };
  const startTime = Date.now();
  const writerName = await _selectBlogWriter('강의', 'pos', '기술 강의 IT');
  context.sectionVariation = _attachWriterPersonas(context.sectionVariation, writerName, 'lecture');
  const contractId = await _hireBlogWriterContract(writerName, `lecture: ${context.lectureTitle || '자동 주제'}`);

  return _executeWithWriterContract(traceCtx, startTime, contractId, async () => {
      const runLocalDraft = _createLocalDraftRunner({
        kind: 'lecture',
        context,
        chunkedLabel: '강의',
        chunkedWriter: writeLecturePostChunked,
        singleWriter: writeLecturePost,
        repairDraft: repairLecturePostDraft,
        buildRepairContext: (ctx) => ctx,
        buildSingleArgs: (ctx, variation) => [ctx.number, ctx.lectureTitle, ctx.researchData, variation],
        buildChunkedArgs: (ctx, variation) => [ctx.number, ctx.lectureTitle, ctx.researchData, variation],
        buildRepairArgs: (ctx, currentPost, quality, variation) => [
          ctx.number,
          ctx.lectureTitle,
          ctx.researchData,
          currentPost,
          quality,
          variation,
        ],
      });

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
      return _attachQualitySummary(finalized, quality);
    });
}

// ─── 일반 포스팅 ──────────────────────────────────────────────────────

async function _fulfillLunaRequest(requestId, postId, category = null, topic = null) {
  await pgPool.run('blog', `
    UPDATE blog.content_requests
    SET status = 'fulfilled',
        fulfilled_post_id = $2,
        fulfilled_at = NOW(),
        fulfilled_category = $3,
        fulfilled_topic = $4
    WHERE id = $1 AND status = 'pending'
  `, [requestId, postId, category, topic]);
  console.log(`[블로] 루나 요청 완료 처리: requestId=${requestId}, postId=${postId}`);
  await _emitEvent('cross_pipeline.luna_blog.fulfilled', {
    request_id: requestId,
    post_id: postId,
    category,
    topic,
  });
}

async function _skipLunaRequest(requestId, reason) {
  try {
    await pgPool.run('blog', `
      UPDATE blog.content_requests
      SET status = 'skipped', skip_reason = $2
      WHERE id = $1 AND status = 'pending'
    `, [requestId, reason]);
    console.log(`[블로/content_requests] #${requestId} → skipped: ${reason}`);
  } catch (err) {
    console.warn('[블로/content_requests] skipped 처리 실패 (무시):', err.message);
  }
}

async function runGeneralPost(researchData, traceCtx, preloaded = {}, scheduleId = null, options = {}, dailyState = {}, lunaRequest = null) {
  const prepared = await _prepareGeneralContext(researchData, traceCtx, preloaded, scheduleId, dailyState, lunaRequest, options);
  if (prepared?.skipped) {
    const skippedResult = prepared.result || { type: 'general', skipped: true, reason: 'skipped' };
    const canFallbackCategory = skippedResult.category === '도서리뷰' && !preloaded._bookFallbackTried;
    if (canFallbackCategory) {
      await advanceGeneralCategory();
      const nextCategoryInfo = await getNextGeneralCategory();
      const fallbackCategory = nextCategoryInfo?.category === '도서리뷰'
        ? _getNextFallbackGeneralCategory(skippedResult.category)
        : (nextCategoryInfo?.category || _getNextFallbackGeneralCategory(skippedResult.category));
      if (scheduleId) {
        await updateScheduleCategory(scheduleId, fallbackCategory);
      }
      console.log(`[블로] 도서리뷰 스킵 — 같은 런에서 다음 일반 카테고리로 전환: ${fallbackCategory}`);
      return runGeneralPost(researchData, traceCtx, {
        ...preloaded,
        category: fallbackCategory,
        bookInfo: null,
        _bookFallbackTried: true,
      }, scheduleId, options, dailyState);
    }
    if (!DEV_HUB_READONLY) {
      await advanceGeneralCategory();
    }
    return skippedResult;
  }
  const context = prepared.context;
  context.daily = {
    senseState: dailyState.senseState || null,
    revenueCorrelation: dailyState.revenueCorrelation || null,
  };
  const startTime = Date.now();
  const writerName = await _selectBlogWriter(
    context.category === '도서리뷰' ? '도서리뷰' : '일반',
    'gems',
    context.category === '도서리뷰' ? '도서 감성 에세이' : (context.category || '에세이')
  );
  context.sectionVariation = _attachWriterPersonas(context.sectionVariation, writerName, 'general');
  const contractId = await _hireBlogWriterContract(writerName, `general: ${context.category || '자동 주제'}`);

  return _executeWithWriterContract(traceCtx, startTime, contractId, async () => {
      const runLocalDraft = _createLocalDraftRunner({
        kind: 'general',
        context,
        chunkedLabel: '일반',
        chunkedWriter: writeGeneralPostChunked,
        singleWriter: writeGeneralPost,
        repairDraft: repairGeneralPostDraft,
        buildRepairContext: (ctx) => ({ category: ctx.category, data: ctx.researchData }),
        buildSingleArgs: (ctx, variation) => [ctx.category, ctx.researchData, variation],
        buildChunkedArgs: (ctx, variation) => [ctx.category, ctx.researchData, variation],
        buildRepairArgs: (ctx, currentPost, quality, variation) => [
          ctx.category,
          ctx.data,
          currentPost,
          quality,
          variation,
        ],
      });

      const { post, quality } = await _resolvePipelineExecution(
        'general',
        context.sectionVariation,
        {
          category: context.category,
          topic: _resolveGeneralPipelineTopic(context),
          dryRun: !!options.dryRun,
        },
        runLocalDraft
      );

      const finalized = await _finalizeGeneralPost(post, quality, context, scheduleId, traceCtx, writerName, options);
      await _markGeneralTopicSelectionConsumed(context, finalized, options);
      if (context.usedLunaRequestId && finalized.postId && !options.dryRun) {
        await _fulfillLunaRequest(
          context.usedLunaRequestId,
          finalized.postId,
          context.category,
          finalized.title || null
        ).catch(e =>
          console.warn('[블로] 루나 요청 완료 처리 실패 (무시):', e.message)
        );
      }
      return _attachQualitySummary(finalized, quality);
    });
}

// ─── 메인 ───────────────────────────────────────────────────────────

async function run(options = {}) {
  console.log('\n📝 [블로] 블로그팀 일간 작업 시작\n');
  if (options.dryRun) {
    console.log('[블로][dry-run] 발행/스케줄 갱신/텔레그램 전송 없이 검증 실행');
  }
  if (options.dryRun && options.phase1FastDryRun) {
    console.log('[블로][phase1-fast-dry-run] Elixir handoff용 경량 dry-run 실행');
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
    console.log('[블로] ✅ 오늘 생성 항목이 모두 완료됨 — 중복 실행 건너뜀');
    return [];
  }
  if (daily.verifyOnly) {
    return [_buildVerifyResult(daily)];
  }

  const results = [];
  const lectureResult = await _runLectureStage(daily, traceCtx, options);
  if (lectureResult) results.push(lectureResult);
  const generalResult = await _runGeneralStage(daily, traceCtx, options);
  if (generalResult) results.push(generalResult);

  await _sendDailyReport(results, traceCtx, { ...options, daily });
  await _runPostPublishChecks(options);

  console.log('\n📝 [블로] 일간 작업 완료\n');
  return results;
}

async function retryLectureOnly(options = {}) {
  console.log('\n📝 [블로] 강의 포스팅 재발행 시작\n');
  if (options.dryRun) {
    console.log('[블로][dry-run] 강의 포스팅 재발행 검증 실행');
  }

  const traceCtx = startTrace({ bot: 'blog-blo', action: 'lecture_retry' });
  console.log(`[블로] trace_id: ${traceCtx.trace_id}`);

  const daily = await _prepareDailyRun(traceCtx, { ...options, lectureOnly: true });
  if (daily.inactive) {
    console.log('[블로] 일시 정지 상태. 종료.');
    return { type: 'lecture', skipped: true, reason: 'inactive' };
  }
  if (!daily.lectureCtx) {
    console.log('[블로] 재발행할 강의 스케줄이 없습니다.');
    return { type: 'lecture', skipped: true, reason: 'lecture_not_scheduled' };
  }

  const lectureResult = await _runLectureStage(daily, traceCtx, options);
  await _runPostPublishChecks(options);

  console.log('\n📝 [블로] 강의 포스팅 재발행 완료\n');
  return lectureResult;
}

async function retryGeneralOnly(options = {}) {
  console.log('\n📝 [블로] 일반 포스팅 재발행 시작\n');
  if (options.dryRun) {
    console.log('[블로][dry-run] 일반 포스팅 재발행 검증 실행');
  }

  const traceCtx = startTrace({ bot: 'blog-blo', action: 'general_retry' });
  console.log(`[블로] trace_id: ${traceCtx.trace_id}`);

  const daily = await _prepareDailyRun(traceCtx, { ...options, generalOnly: true });
  if (daily.inactive) {
    console.log('[블로] 일시 정지 상태. 종료.');
    return { type: 'general', skipped: true, reason: 'inactive' };
  }
  if (!daily.generalCtx) {
    console.log('[블로] 재발행할 일반 스케줄이 없습니다.');
    return { type: 'general', skipped: true, reason: 'general_not_scheduled' };
  }

  const generalResult = await _runGeneralStage(daily, traceCtx, options);
  await _runPostPublishChecks(options);

  console.log('\n📝 [블로] 일반 포스팅 재발행 완료\n');
  return generalResult;
}

module.exports = { run, retryLectureOnly, retryGeneralOnly };
