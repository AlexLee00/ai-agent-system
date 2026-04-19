// @ts-nocheck
'use strict';

/**
 * curriculum-planner.js (리처) — 차기 강의 시리즈 자동 선정
 *
 * 흐름:
 *   ① blo.js가 매일 dailyCurriculumCheck() 호출
 *   ② 현재 시리즈 잔여 7강 이하 → 트리거
 *   ③ 리처: HN + GitHub 트렌드 수집
 *   ④ LLM: 후보 3개 추천 → 텔레그램 제안
 *   ⑤ 마스터 승인 번호 회신 → generateCurriculum() 실행
 *   ⑥ DB 저장 → 현재 시리즈 종료 후 자동 전환
 */

const https = require('https');
const pgPool = require('../../../packages/core/lib/pg-pool');
const { callWithFallback } = require('../../../packages/core/lib/llm-fallback');
const { selectLLMChain } = require('../../../packages/core/lib/llm-model-selector');
const { runIfOps } = require('../../../packages/core/lib/mode-guard');
const { postAlarm } = require('../../../packages/core/lib/openclaw-client');
const { createAgentMemory } = require('../../../packages/core/lib/agent-memory');
const {
  buildNoticeEvent,
  renderNoticeEvent,
} = require('../../../packages/core/lib/reporting-hub');
const {
  ensureBlogFeedbackTables,
  createCurriculumProposalSession,
  markCurriculumProposalCommitted,
} = require('./ai-feedback.ts');
const { getBlogLLMSelectorOverrides } = require('./runtime-config.ts');

const DAYS_BEFORE_END = 7;
const MIN_LECTURES = 100;
const curriculumMemory = createAgentMemory({ agentId: 'blog.curriculum', team: 'blog' });

function buildCurriculumMemoryQuery(kind, values = []) {
  return [
    'blog curriculum',
    kind,
    ...values,
  ].filter(Boolean).map((item) => String(item || '').trim()).filter(Boolean).join(' ');
}

function _httpsGet(url, headers = {}, timeout = 12000) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'ai-agent-blog/1.0', ...headers },
      timeout,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function getActiveSeries() {
  try {
    const rows = await pgPool.query('blog', `
      SELECT * FROM blog.curriculum_series
      WHERE status = 'active'
      ORDER BY id DESC LIMIT 1
    `);
    return rows[0] || null;
  } catch (e) {
    console.warn('[커리큘럼] 시리즈 조회 실패 (테이블 미생성?):', e.message);
    return null;
  }
}

async function checkSeriesEndingSoon() {
  const series = await getActiveSeries();
  if (!series) return { needsPlanning: false };

  let currentLecture = 0;
  try {
    const rotRow = await pgPool.query('blog', `
      SELECT current_index FROM blog.category_rotation
      WHERE rotation_type = 'lecture_series' LIMIT 1
    `);
    currentLecture = rotRow[0]?.current_index ?? 0;
  } catch {
    // ignore
  }

  const remaining = series.total_lectures - currentLecture;

  let nextExists = false;
  try {
    const next = await pgPool.query('blog', `
      SELECT id FROM blog.curriculum_series WHERE status IN ('planned', 'candidate') LIMIT 1
    `);
    nextExists = next.length > 0;
  } catch {
    // ignore
  }

  return {
    needsPlanning: remaining <= DAYS_BEFORE_END && !nextExists,
    currentSeries: series,
    currentLecture,
    remainingLectures: remaining,
  };
}

async function searchCommunityTrends() {
  const trends = [];

  try {
    const topIds = await _httpsGet('https://hacker-news.firebaseio.com/v0/topstories.json');
    if (Array.isArray(topIds)) {
      const top20 = await Promise.allSettled(
        topIds.slice(0, 20).map((id) =>
          _httpsGet(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)
        )
      );
      for (const r of top20) {
        if (r.status === 'fulfilled' && r.value?.title) {
          trends.push({
            topic: r.value.title,
            source: 'hacker_news',
            score: r.value.score || 0,
            url: r.value.url,
          });
        }
      }
    }
  } catch (e) {
    console.warn('[커리큘럼] HN 트렌드 실패:', e.message);
  }

  try {
    const ghData = await _httpsGet(
      'https://api.github.com/search/repositories?q=stars:>5000+pushed:>2026-01-01&sort=stars&order=desc&per_page=30',
      { Accept: 'application/vnd.github.v3+json' }
    );
    if (ghData?.items) {
      const langCount = {};
      for (const repo of ghData.items) {
        if (repo.language) langCount[repo.language] = (langCount[repo.language] || 0) + 1;
      }
      const sorted = Object.entries(langCount).sort((a, b) => b[1] - a[1]);
      for (const [lang, count] of sorted.slice(0, 7)) {
        trends.push({ topic: lang, source: 'github_trending', score: count * 100 });
      }
    }
  } catch (e) {
    console.warn('[커리큘럼] GitHub 트렌드 실패:', e.message);
  }

  console.log(`[커리큘럼] 커뮤니티 트렌드 ${trends.length}건 수집`);
  return trends;
}

const PLANNER_SYSTEM = `당신은 IT 교육 커리큘럼 전문가입니다.
개발 커뮤니티 트렌드 데이터를 분석하여 블로그 강의 시리즈 주제를 추천합니다.

추천 기준:
- 현재 개발 커뮤니티에서 가장 이슈가 되는 언어 또는 기술
- 100강 이상 진행할 수 있을 만큼 풍부한 커리큘럼 구성 가능
- 블로그 독자(초중급 개발자)에게 실용적 가치
- 이전 시리즈와 중복되지 않는 새로운 주제

응답 형식 (JSON만, 코드블록 없이):
{"candidates":[{"topic":"Python","subtitle":"데이터 과학과 자동화의 왕도","reason":"추천 이유 100자","difficulty":"초급~중급","estimated_lectures":120,"sample_curriculum":["1강: 개발 환경 설정","2강: 변수와 자료형","50강: 웹 크롤링","80강: FastAPI","100강: 프로젝트"]}]}
candidates는 정확히 3개.`.trim();

async function recommendNextSeries(currentSeriesName, trends, completedSeries = []) {
  const selectorOverrides = getBlogLLMSelectorOverrides();
  const trendSummary = trends.slice(0, 15)
    .map((t) => `[${t.source}] ${t.topic} (점수: ${t.score})`)
    .join('\n');

  const completedList = completedSeries.length > 0
    ? completedSeries.map((s) => `- ${s}`).join('\n')
    : `- ${currentSeriesName}`;

  const userPrompt = `현재 진행 중인 시리즈: ${currentSeriesName} (곧 종료 예정)

[이전 완료/진행 시리즈 — 중복 금지]
${completedList}

[커뮤니티 트렌드 데이터]
${trendSummary}

차기 강의 시리즈 후보 3개를 추천하라.
각 후보에 전체 강의 중 대표 강의 5개를 샘플로 포함.`.trim();

  try {
    const result = await callWithFallback({
      chain: selectLLMChain('blog.curriculum.recommend', {
        policyOverride: selectorOverrides['blog.curriculum.recommend'],
      }),
      systemPrompt: PLANNER_SYSTEM,
      userPrompt,
      logMeta: { team: 'blog', purpose: 'curriculum', bot: 'blog-richer', requestType: 'curriculum_planning' },
    });

    const match = result.text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch (e) {
    console.error('[커리큘럼] LLM 추천 실패:', e.message);
    return null;
  }
}

async function proposeToMaster(candidates, currentSeries, remainingLectures) {
  if (!candidates?.candidates?.length) return;
  await ensureBlogFeedbackTables();

  const nums = ['1️⃣', '2️⃣', '3️⃣'];
  const lines = [
    `📚 [차기 강의 시리즈 제안]`,
    `현재: ${currentSeries.series_name} (잔여 ${remainingLectures}강)`,
    '',
  ];

  for (const [i, c] of candidates.candidates.entries()) {
    lines.push(`${nums[i]} ${c.topic} — ${c.subtitle}`);
    lines.push(`   난이도: ${c.difficulty} | ${c.estimated_lectures}강`);
    lines.push(`   이유: ${c.reason}`);
    if (c.sample_curriculum?.length) {
      lines.push(`   샘플: ${c.sample_curriculum.slice(0, 3).join(', ')}`);
    }
    lines.push('');
  }
  lines.push('승인할 번호를 텔레그램으로 회신해주세요 (1/2/3)');
  lines.push('또는 직접 주제를 입력해주세요.');

  const msg = lines.join('\n');
  const memoryQuery = buildCurriculumMemoryQuery('proposal', [
    currentSeries?.series_name,
    candidates.candidates[0]?.topic,
  ]);
  const episodicHint = await curriculumMemory.recallCountHint(memoryQuery, {
    type: 'episodic',
    limit: 2,
    threshold: 0.33,
    title: '최근 유사 제안',
    separator: 'pipe',
    metadataKey: 'kind',
    labels: {
      proposal: '제안',
      generated: '생성',
      transitioned: '전환',
    },
    order: ['proposal', 'generated', 'transitioned'],
  }).catch(() => '');
  const semanticHint = await curriculumMemory.recallHint(`${memoryQuery} consolidated curriculum pattern`, {
    type: 'semantic',
    limit: 2,
    threshold: 0.28,
    title: '최근 통합 패턴',
    separator: 'newline',
  }).catch(() => '');
  const notice = buildNoticeEvent({
    from_bot: 'blog-richer',
    team: 'blog',
    event_type: 'proposal',
    alert_level: 2,
    title: '차기 강의 시리즈 제안',
    summary: `현재 ${currentSeries.series_name}, 잔여 ${remainingLectures}강`,
    details: candidates.candidates.map((c, i) =>
      `${nums[i]} ${c.topic} | ${c.difficulty} | ${c.estimated_lectures}강`
    ),
    action: '텔레그램에서 1/2/3 또는 직접 주제를 회신하세요.',
    payload: {
      title: '차기 강의 시리즈 제안',
      summary: `현재 ${currentSeries.series_name}, 잔여 ${remainingLectures}강`,
      details: candidates.candidates.map((c, i) => `${nums[i]} ${c.topic} — ${c.subtitle}`),
      action: '1/2/3 또는 직접 주제 회신',
    },
  });
  const rendered = `${renderNoticeEvent(notice) || msg}${episodicHint}${semanticHint}`;
  await runIfOps(
    'blog-tg',
    () => postAlarm({
      message: rendered,
      team: 'blog',
      alertLevel: notice.alert_level || 2,
      fromBot: 'blog-richer',
    }),
    () => console.log('[DEV] 텔레그램 생략\n' + rendered)
  );
  await curriculumMemory.remember(rendered, 'episodic', {
    importance: 0.7,
    expiresIn: 1000 * 60 * 60 * 24 * 30,
    metadata: {
      kind: 'proposal',
      currentSeries: currentSeries?.series_name || null,
      remainingLectures,
      candidateTopics: candidates.candidates.map((c) => c.topic).slice(0, 3),
    },
  }).catch(() => {});
  await curriculumMemory.consolidate({
    olderThanDays: 14,
    limit: 10,
  }).catch(() => {});

  const feedbackSession = await createCurriculumProposalSession({
    currentSeries,
    remainingLectures,
    candidates: candidates.candidates,
  });

  for (const c of candidates.candidates) {
    try {
      await pgPool.run('blog', `
        INSERT INTO blog.curriculum_series (series_name, total_lectures, status, feedback_session_id)
        VALUES ($1, $2, 'candidate', $3)
      `, [c.topic, c.estimated_lectures || MIN_LECTURES, feedbackSession.id]);
    } catch {
      // ignore
    }
  }

  console.log('[커리큘럼] 마스터에게 후보 3개 제안 완료');
}

const CURRICULUM_SYSTEM = `당신은 IT 교육 커리큘럼 설계 전문가입니다.
체계적인 블로그 강의 커리큘럼을 생성합니다.

원칙:
- 초급부터 고급까지 단계적 진행
- 실무 프로젝트 포함
- 각 강의 제목은 구체적이고 네이버 검색 친화적으로

응답 형식 (JSON만, 코드블록 없이):
{"curriculum":[{"lecture":1,"title":"개발 환경 설정과 첫 프로그램","section":"기초","keywords":["설치","환경설정"]}]}
정확히 지정된 강의 수만큼 생성.`.trim();

async function generateCurriculum(topic, lectureCount = 100) {
  const selectorOverrides = getBlogLLMSelectorOverrides();
  await ensureBlogFeedbackTables();
  const candidateSeries = await pgPool.get('blog', `
    SELECT feedback_session_id
    FROM blog.curriculum_series
    WHERE status='candidate'
      AND series_name=$1
      AND feedback_session_id IS NOT NULL
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `, [topic]);

  const userPrompt = `"${topic}" 주제로 ${lectureCount}강 블로그 커리큘럼을 생성하라.

구조:
  1~10강:    기초 (환경 설정, 기본 문법, 핵심 개념)
  11~30강:   초급 (핵심 기능, 표준 라이브러리, 기본 패턴)
  31~60강:   중급 (고급 패턴, 프레임워크, 외부 연동)
  61~80강:   고급 (아키텍처, 성능 최적화, 보안)
  81~90강:   프로젝트 (실전 프로젝트 구현)
  91~${lectureCount}강: 마무리 (베스트 프랙티스, 커리어 가이드, 다음 학습 로드맵)

각 강의 제목: "[${topic} N강] 제목" 형태로, 네이버 검색 최적화`.trim();

  let parsed;
  try {
    const result = await callWithFallback({
      chain: selectLLMChain('blog.curriculum.generate', {
        policyOverride: selectorOverrides['blog.curriculum.generate'],
      }),
      systemPrompt: CURRICULUM_SYSTEM,
      userPrompt,
      logMeta: { team: 'blog', purpose: 'curriculum', bot: 'blog-richer', requestType: 'curriculum_generate' },
    });
    const match = result.text.match(/\{[\s\S]*\}/);
    parsed = match ? JSON.parse(match[0]) : null;
  } catch (e) {
    console.error('[커리큘럼] LLM 생성 실패:', e.message);
    return null;
  }

  if (!parsed?.curriculum?.length) {
    console.error('[커리큘럼] 파싱 실패');
    return null;
  }

  const seriesRows = await pgPool.query('blog', `
    INSERT INTO blog.curriculum_series (series_name, total_lectures, status, feedback_session_id)
    VALUES ($1, $2, 'planned', $3)
    RETURNING id
  `, [topic, parsed.curriculum.length, candidateSeries?.feedback_session_id || null]);
  const seriesId = seriesRows[0].id;

  for (const lec of parsed.curriculum) {
    await pgPool.run('blog', `
      INSERT INTO blog.curriculum (series_id, series_name, lecture_number, title, section, keywords)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (series_id, lecture_number) DO NOTHING
    `, [seriesId, topic, lec.lecture, lec.title, lec.section || null, lec.keywords || []]);
  }

  await pgPool.run('blog', `DELETE FROM blog.curriculum_series WHERE status = 'candidate'`);

  const msg = `📚 [커리큘럼 생성 완료]\n${topic} ${parsed.curriculum.length}강\n\n샘플:\n${parsed.curriculum.slice(0, 5).map((l) => `  ${l.lecture}강: ${l.title}`).join('\n')}`;
  console.log('[커리큘럼] ✅', msg.replace(/\n/g, ' | '));
  const generatedMemoryQuery = buildCurriculumMemoryQuery('generated', [topic, String(parsed.curriculum.length)]);
  const generatedEpisodicHint = await curriculumMemory.recallCountHint(generatedMemoryQuery, {
    type: 'episodic',
    limit: 2,
    threshold: 0.33,
    title: '최근 유사 생성',
    separator: 'pipe',
    metadataKey: 'kind',
    labels: {
      generated: '생성',
      transitioned: '전환',
      proposal: '제안',
    },
    order: ['generated', 'transitioned', 'proposal'],
  }).catch(() => '');
  const generatedSemanticHint = await curriculumMemory.recallHint(`${generatedMemoryQuery} consolidated curriculum pattern`, {
    type: 'semantic',
    limit: 2,
    threshold: 0.28,
    title: '최근 통합 패턴',
    separator: 'newline',
  }).catch(() => '');
  const createdNotice = buildNoticeEvent({
    from_bot: 'blog-richer',
    team: 'blog',
    event_type: 'report',
    alert_level: 1,
    title: '커리큘럼 생성 완료',
    summary: `${topic} ${parsed.curriculum.length}강`,
    details: parsed.curriculum.slice(0, 5).map((l) => `${l.lecture}강: ${l.title}`),
    action: 'planned 시리즈로 저장되었습니다.',
    payload: {
      title: '커리큘럼 생성 완료',
      summary: `${topic} ${parsed.curriculum.length}강`,
      details: parsed.curriculum.slice(0, 5).map((l) => `${l.lecture}강: ${l.title}`),
    },
  });
  await runIfOps(
    'blog-tg',
    () => postAlarm({
      message: `${renderNoticeEvent(createdNotice) || msg}${generatedEpisodicHint}${generatedSemanticHint}`,
      team: 'blog',
      alertLevel: createdNotice.alert_level || 1,
      fromBot: 'blog-richer',
    }),
    () => {}
  );
  await curriculumMemory.remember(msg, 'episodic', {
    importance: 0.72,
    expiresIn: 1000 * 60 * 60 * 24 * 30,
    metadata: {
      kind: 'generated',
      topic,
      lectureCount: parsed.curriculum.length,
      seriesId,
    },
  }).catch(() => {});
  await curriculumMemory.consolidate({
    olderThanDays: 14,
    limit: 10,
  }).catch(() => {});

  if (candidateSeries?.feedback_session_id) {
    await markCurriculumProposalCommitted({
      sessionId: candidateSeries.feedback_session_id,
      topic,
      lectureCount: parsed.curriculum.length,
      seriesId,
    });
  }

  return { seriesId, lectureCount: parsed.curriculum.length };
}

async function transitionSeries() {
  try {
    await pgPool.run('blog', `
      UPDATE blog.curriculum_series
      SET status = 'completed', end_date = CURRENT_DATE
      WHERE status = 'active'
    `);

    const next = await pgPool.query('blog', `
      UPDATE blog.curriculum_series
      SET status = 'active', start_date = CURRENT_DATE
      WHERE status = 'planned'
      ORDER BY id ASC
      LIMIT 1
      RETURNING *
    `);

    if (next.length > 0) {
      const n = next[0];
      console.log(`[커리큘럼] 🔄 시리즈 전환: ${n.series_name} ${n.total_lectures}강 시작!`);
      const msg = `🔄 [시리즈 전환]\n새 시리즈: ${n.series_name} (${n.total_lectures}강)\n오늘부터 1강 시작!`;
      const transitionMemoryQuery = buildCurriculumMemoryQuery('transition', [n.series_name, String(n.total_lectures)]);
      const transitionEpisodicHint = await curriculumMemory.recallCountHint(transitionMemoryQuery, {
        type: 'episodic',
        limit: 2,
        threshold: 0.33,
        title: '최근 유사 전환',
        separator: 'pipe',
        metadataKey: 'kind',
        labels: {
          transitioned: '전환',
          generated: '생성',
        },
        order: ['transitioned', 'generated'],
      }).catch(() => '');
      const transitionSemanticHint = await curriculumMemory.recallHint(`${transitionMemoryQuery} consolidated curriculum pattern`, {
        type: 'semantic',
        limit: 2,
        threshold: 0.28,
        title: '최근 통합 패턴',
        separator: 'newline',
      }).catch(() => '');
      const transitionNotice = buildNoticeEvent({
        from_bot: 'blog-richer',
        team: 'blog',
        event_type: 'report',
        alert_level: 2,
        title: '시리즈 전환',
        summary: `새 시리즈: ${n.series_name} (${n.total_lectures}강)`,
        details: ['오늘부터 1강 시작'],
        payload: {
          title: '시리즈 전환',
          summary: `새 시리즈: ${n.series_name} (${n.total_lectures}강)`,
          details: ['오늘부터 1강 시작'],
        },
      });
      await runIfOps(
        'blog-tg',
        () => postAlarm({
          message: `${renderNoticeEvent(transitionNotice) || msg}${transitionEpisodicHint}${transitionSemanticHint}`,
          team: 'blog',
          alertLevel: transitionNotice.alert_level || 2,
          fromBot: 'blog-richer',
        }),
        () => console.log('[DEV] 시리즈 전환 생략')
      );
      await curriculumMemory.remember(msg, 'episodic', {
        importance: 0.68,
        expiresIn: 1000 * 60 * 60 * 24 * 30,
        metadata: {
          kind: 'transitioned',
          seriesName: n.series_name,
          lectureCount: n.total_lectures,
        },
      }).catch(() => {});
      await curriculumMemory.consolidate({
        olderThanDays: 14,
        limit: 10,
      }).catch(() => {});
      return n;
    }

    console.warn('[커리큘럼] ⚠️ planned 시리즈 없음 — 수동 설정 필요');
    return null;
  } catch (e) {
    console.warn('[커리큘럼] 시리즈 전환 실패:', e.message);
    return null;
  }
}

async function getNextLectureTitle(seriesName, lectureNumber) {
  try {
    const rows = await pgPool.query('blog', `
      SELECT c.title
      FROM blog.curriculum c
      JOIN blog.curriculum_series s ON c.series_id = s.id
      WHERE s.series_name = $1 AND c.lecture_number = $2
        AND s.status = 'active'
      LIMIT 1
    `, [seriesName, lectureNumber]);
    return rows[0]?.title || null;
  } catch {
    return null;
  }
}

async function dailyCurriculumCheck() {
  let check;
  try {
    check = await checkSeriesEndingSoon();
  } catch (e) {
    console.warn('[커리큘럼] 체크 실패 (테이블 미초기화?):', e.message);
    return;
  }

  if (!check.needsPlanning) {
    if (check.remainingLectures != null) {
      console.log(`[커리큘럼] ${check.currentSeries?.series_name} 잔여 ${check.remainingLectures}강 — 계획 불필요`);
    }
    return;
  }

  console.log(`[커리큘럼] ⚠️ ${check.currentSeries.series_name} 종료 ${check.remainingLectures}강 전 — 차기 주제 선정 시작`);

  const trends = await searchCommunityTrends();

  let completedNames = [check.currentSeries.series_name];
  try {
    const completed = await pgPool.query('blog', `
      SELECT series_name FROM blog.curriculum_series
      WHERE status IN ('active', 'completed')
    `);
    completedNames = completed.map((r) => r.series_name);
  } catch {
    // ignore
  }

  const candidates = await recommendNextSeries(
    check.currentSeries.series_name,
    trends,
    completedNames
  );

  if (candidates?.candidates?.length) {
    await proposeToMaster(candidates, check.currentSeries, check.remainingLectures);
  }
}

module.exports = {
  getActiveSeries,
  checkSeriesEndingSoon,
  searchCommunityTrends,
  recommendNextSeries,
  generateCurriculum,
  transitionSeries,
  getNextLectureTitle,
  dailyCurriculumCheck,
  MIN_LECTURES,
  DAYS_BEFORE_END,
};
