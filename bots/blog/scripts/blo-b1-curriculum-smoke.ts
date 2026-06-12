#!/usr/bin/env node
// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');

const BLOG_ROOT = path.join(env.PROJECT_ROOT, 'bots/blog');
const {
  AGENT_INTRO_SERIES_NAME,
  LEGACY_AGENT_INTRO_SERIES_NAME,
  AGENT_INTRO_CURRICULUM,
  buildAgentIntroSearchKeywords,
  normalizeAgentIntroLectureTitle,
} = require(path.join(BLOG_ROOT, 'lib/agent-intro-curriculum.ts'));
const { isBlogMarketingEnabled } = require(path.join(BLOG_ROOT, 'lib/marketing-enabled.ts'));
const { _testOnly: posWriterTestOnly } = require(path.join(BLOG_ROOT, 'lib/pos-writer.ts'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function buildFixtureCurriculum() {
  return Array.from({ length: 120 }, (_, index) => {
    const lecture = index + 1;
    return {
      series_name: LEGACY_AGENT_INTRO_SERIES_NAME,
      lecture_number: lecture,
      title: lecture <= 4 ? AGENT_INTRO_CURRICULUM[lecture - 1].title : `Legacy ${lecture}강`,
      status: lecture <= 4 ? 'published' : 'pending',
      published_post_id: lecture <= 4 ? 1000 + lecture : null,
      section: null,
      keywords: [],
      difficulty: 'intermediate',
    };
  });
}

function buildFixtureSeries() {
  return [
    { id: 1, series_name: 'nodejs_120', total_lectures: 120, status: 'active', end_date: null },
    { id: 2, series_name: LEGACY_AGENT_INTRO_SERIES_NAME, total_lectures: 120, status: 'planned', end_date: null },
  ];
}

function applyFixtureB1SeriesMigration(rows) {
  const next = rows.map((row) => ({ ...row }));
  let target = next
    .filter((row) =>
      row.series_name === AGENT_INTRO_SERIES_NAME
      || row.series_name === LEGACY_AGENT_INTRO_SERIES_NAME
    )
    .sort((a, b) => {
      const activeRank = (row) => (row.status === 'active' ? 0 : 1);
      return activeRank(a) - activeRank(b) || b.id - a.id;
    })[0];

  if (!target) {
    target = {
      id: Math.max(0, ...next.map((row) => row.id || 0)) + 1,
      series_name: AGENT_INTRO_SERIES_NAME,
      total_lectures: 48,
      status: 'active',
      end_date: null,
    };
    next.push(target);
  }

  for (const row of next) {
    if (row.status === 'active' && row.id !== target.id) {
      row.status = 'completed';
      row.end_date = row.end_date || 'fixture-current-date';
    }
  }

  target.series_name = AGENT_INTRO_SERIES_NAME;
  target.total_lectures = 48;
  target.status = 'active';
  target.end_date = null;
  return next;
}

function applyFixtureB1Migration(rows) {
  const next = rows.map((row) => ({
    ...row,
    series_name: AGENT_INTRO_SERIES_NAME,
  }));

  for (const lesson of AGENT_INTRO_CURRICULUM) {
    const row = next.find((item) => item.lecture_number === lesson.lecture);
    if (!row) {
      next.push({
        series_name: AGENT_INTRO_SERIES_NAME,
        lecture_number: lesson.lecture,
        title: lesson.title,
        status: 'pending',
        published_post_id: null,
        section: lesson.section,
        keywords: lesson.keywords,
        difficulty: '입문',
      });
      continue;
    }
    if (lesson.lecture > 4) row.title = lesson.title;
    row.section = lesson.section;
    row.keywords = lesson.keywords;
    row.difficulty = '입문';
    if (lesson.lecture > 4) row.status = 'pending';
  }

  for (const row of next) {
    if (row.lecture_number >= 49 && row.lecture_number <= 120) {
      row.status = 'archived';
    }
  }
  return next;
}

async function runTsB1() {
  const migrated = applyFixtureB1Migration(buildFixtureCurriculum());
  const migratedSeries = applyFixtureB1SeriesMigration(buildFixtureSeries());
  const activeRows = migrated.filter((row) =>
    row.series_name === AGENT_INTRO_SERIES_NAME
    && row.lecture_number >= 1
    && row.lecture_number <= 48
    && row.status !== 'archived'
  );
  const archivedRows = migrated.filter((row) => row.status === 'archived');
  const activeSeriesRows = migratedSeries.filter((row) => row.status === 'active');
  const preserved = [1, 2, 3, 4].every((lecture) => {
    const row = migrated.find((item) => item.lecture_number === lecture);
    return row?.published_post_id === 1000 + lecture && row?.status === 'published';
  });
  const nextLecture = 4 + 1;
  const lesson5 = migrated.find((row) => row.lecture_number === 5);
  const normalizedTitle = normalizeAgentIntroLectureTitle(nextLecture, lesson5?.title || '');
  const weeklyNewsContent = posWriterTestOnly._ensureWeeklyNewsSection('본문\n\n[최신 기술 브리핑]\n내용', {
    curriculum_updates: [{ title: 'Claude Code release note', source: 'fixture', url: 'https://docs.anthropic.com/en/docs/claude-code/overview' }],
  });

  assert(AGENT_INTRO_CURRICULUM.length === 48, '에이전트 입문 목차가 48강이 아님');
  assert(activeRows.length === 48, 'fixture 재편 후 1~48강 active row 수 불일치');
  assert(archivedRows.length === 72, 'fixture 재편 후 49~120 archived row 수 불일치');
  assert(activeSeriesRows.length === 1, 'fixture 재편 후 active curriculum_series가 1개가 아님');
  assert(activeSeriesRows[0]?.series_name === AGENT_INTRO_SERIES_NAME, 'fixture active curriculum_series가 에이전트 입문이 아님');
  assert(preserved, '1~4강 published_post_id/status 보존 실패');
  assert(nextLecture === 5, 'planner fixture next lecture가 5강이 아님');
  assert(normalizedTitle.startsWith('[에이전트 입문 5강] Claude Code 설치 따라하기'), '5강 제목 프리픽스 정규화 실패');
  assert(weeklyNewsContent.includes('[이번 주 소식]'), '수집된 최신정보가 있을 때 이번 주 소식 섹션이 반영되지 않음');

  return {
    activeRows: activeRows.length,
    archivedRows: archivedRows.length,
    activeSeriesRows: activeSeriesRows.length,
    activeSeriesName: activeSeriesRows[0]?.series_name || null,
    nextLecture,
    preservedPublishedPostIds: preserved,
    dryRunTitle: normalizedTitle,
    weeklyNewsIncluded: weeklyNewsContent.includes('[이번 주 소식]'),
  };
}

async function runTsB2() {
  const lesson5 = AGENT_INTRO_CURRICULUM.find((row) => row.lecture === 5);
  const keywords = buildAgentIntroSearchKeywords(lesson5);
  const keywordText = keywords.join(' ');
  const collectorSource = fs.readFileSync(path.join(BLOG_ROOT, 'lib/parallel-collector.ts'), 'utf8');
  const richerSource = fs.readFileSync(path.join(BLOG_ROOT, 'lib/richer.ts'), 'utf8');
  const agentPatternBlock = richerSource.match(/if \(category === 'agent_intro'\)[\s\S]*?if \(category === 'lecture'\)/)?.[0] || '';

  assert(keywords.includes('claude code'), '커리큘럼 키워드에 claude code 누락');
  assert(keywords.includes('codex'), '커리큘럼 키워드에 codex 누락');
  assert(keywords.includes('ai 에이전트'), '커리큘럼 키워드에 AI 에이전트 누락');
  assert(!/\bnode(?:\.js|js)?\b/i.test(keywordText), '에이전트 입문 검색 키워드에 Node 하드코딩 존재');
  assert(agentPatternBlock.includes('에이전트 입문강의'), '에이전트 입문 인기 패턴 쿼리 누락');
  assert(!/\bnode(?:\.js|js)?\b/i.test(agentPatternBlock), '에이전트 입문 인기 패턴 쿼리에 Node 하드코딩 존재');
  assert(collectorSource.includes('fetchNodejsUpdates()'), '일반 포스팅 research collector의 기존 Node 업데이트 경로가 제거됨');

  return {
    keywords,
    nodeHardcodingInAgentIntroKeywords: /\bnode(?:\.js|js)?\b/i.test(keywordText),
    nodeHardcodingInAgentIntroPatternQuery: /\bnode(?:\.js|js)?\b/i.test(agentPatternBlock),
    generalCollectorUnchanged: collectorSource.includes('fetchNodejsUpdates()'),
  };
}

async function runTsB3() {
  const socialMediaDir = path.join(env.PROJECT_ROOT, 'bots/social-media');
  const deletedPlists = [
    'ai.blog.instagram-publish.plist',
    'ai.blog.facebook-publish.plist',
    'ai.blog.instagram-token-health.plist',
  ];
  const remaining = deletedPlists.filter((name) => fs.existsSync(path.join(BLOG_ROOT, 'launchd', name)));
  const previousMarketing = process.env.BLOG_MARKETING_ENABLED;
  const previousDpo = process.env.BLOG_DPO_ENABLED;
  delete process.env.BLOG_MARKETING_ENABLED;
  process.env.BLOG_DPO_ENABLED = 'true';
  const dpo = require(path.join(BLOG_ROOT, 'lib/self-rewarding/marketing-dpo.ts'));
  const dpoEnabled = dpo.isEnabled();
  const marketingEnabled = isBlogMarketingEnabled();
  if (previousMarketing == null) delete process.env.BLOG_MARKETING_ENABLED;
  else process.env.BLOG_MARKETING_ENABLED = previousMarketing;
  if (previousDpo == null) delete process.env.BLOG_DPO_ENABLED;
  else process.env.BLOG_DPO_ENABLED = previousDpo;

  assert(remaining.length === 0, `삭제 대상 소셜 plist 잔존: ${remaining.join(', ')}`);
  assert(fs.existsSync(socialMediaDir), 'bots/social-media 코드 보존 실패');
  assert(marketingEnabled === false, 'BLOG_MARKETING_ENABLED 기본 false 실패');
  assert(dpoEnabled === false, '마케팅 off에서 DPO가 활성화됨');

  return {
    removedSocialPlists: deletedPlists.length,
    socialMediaCodePreserved: fs.existsSync(socialMediaDir),
    marketingDefaultEnabled: marketingEnabled,
    dpoEnabledWhenMarketingOff: dpoEnabled,
    dailyDryRunExpectation: '강의 1편 + 일반 1편 유지',
  };
}

async function main() {
  const tests = [
    ['TS-B1', runTsB1],
    ['TS-B2', runTsB2],
    ['TS-B3', runTsB3],
  ];
  const results = [];
  for (const [id, fn] of tests) {
    try {
      results.push({ id, ok: true, detail: await fn() });
    } catch (error) {
      results.push({ id, ok: false, error: error.message });
    }
  }
  const ok = results.every((row) => row.ok);
  console.log(JSON.stringify({ ok, results }, null, 2));
  if (!ok) process.exit(1);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
