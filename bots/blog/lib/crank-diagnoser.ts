// @ts-nocheck
'use strict';

const crypto = require('crypto');
const path = require('path');
const pgPool = require('../../../packages/core/lib/pg-pool');
const { callHubLlm } = require('../../../packages/core/lib/hub-client');
const {
  WRITING_LEARNINGS_FORMAT_VERSION,
  appendWritingLearningsSummary,
} = require('./writing-learnings.ts');
const { buildWriterModelCrankComparisonFromDb } = require('./writer-model-crank-report.ts');

const DETAIL_AXES = [
  ['dia_depth', 'DIA depth'],
  ['geo_citation', 'GEO citation'],
  ['geo_structure', 'GEO structure'],
  ['crank_content', 'C-Rank content'],
  ['dia_intent', 'DIA intent'],
  ['dia_uniqueness', 'DIA uniqueness'],
  ['geo_ai', 'GEO AI friendliness'],
  ['crank_context', 'C-Rank context'],
  ['crank_chain', 'C-Rank chain'],
  ['crank_creator', 'C-Rank creator'],
];

const TITLE_PATTERNS = [
  { key: 'n_list', label: 'N가지/N개형', pattern: /\d+\s*(가지|개|단계|종|가지로|개로)|[0-9]+/ },
  { key: 'how_to', label: '~하는 법', pattern: /하는\s*법|방법|가이드|정리법|점검법/ },
  { key: 'why', label: '~하는 이유/왜', pattern: /왜|이유/ },
  { key: 'question', label: '질문형', pattern: /\?|까요|일까|뭘까|무엇/ },
  { key: 'experience', label: '경험서사형', pattern: /후기|경험|회고|직접|실제로/ },
  { key: 'contrast', label: '대비형', pattern: /보다|대신|vs|VS|차이|비교/ },
];

const DEFAULT_TITLE_LIMIT = 60;

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function inferWriter(row = {}) {
  return String(row.post_type || '') === 'lecture' ? 'pos' : 'gems';
}

function normalizeCategory(row = {}) {
  return normalizeText(row.category || row.post_category || 'uncategorized') || 'uncategorized';
}

function selectLowestAxis(row = {}) {
  let selected = null;
  for (const [axis, label] of DETAIL_AXES) {
    const score = Number(row?.[axis]);
    if (!Number.isFinite(score)) continue;
    if (!selected || score < selected.score) selected = { axis, label, score };
  }
  return selected || { axis: 'unknown', label: 'unknown', score: 0 };
}

function ruleLessonForAxis(row = {}, lowest = selectLowestAxis(row)) {
  const title = normalizeText(row.title || `post ${row.post_id || ''}`);
  const category = normalizeCategory(row);
  const score = Number(lowest.score || 0);
  const templates = {
    dia_depth: '제품·개념 설명은 있지만 사용 맥락, 비교 경험, 실행 전후 차이가 부족합니다.',
    geo_citation: '검증 가능한 출처·근거·수치가 약해 AI 검색 인용 근거로 쓰기 어렵습니다.',
    geo_structure: '요약, h태그 흐름, 표/목록 구조가 약해 핵심을 빠르게 스캔하기 어렵습니다.',
    crank_content: '본문 주장은 있으나 구체 사례와 독자가 바로 할 행동이 부족합니다.',
    dia_intent: '검색자가 실제로 묻는 질문과 본문 답변의 연결이 느슨합니다.',
    dia_uniqueness: '일반론 비중이 높아 운영 경험이나 비교 관점의 고유성이 약합니다.',
    geo_ai: 'AI가 한 문장으로 인용할 명확한 결론과 FAQ형 답변이 부족합니다.',
    crank_context: '카테고리 맥락과 독자 상황 정의가 부족해 글의 출발점이 흐립니다.',
    crank_chain: '관련 글/다음 행동/내부 연결이 약해 독자 여정이 끊깁니다.',
    crank_creator: '운영자 경험과 신뢰 근거가 충분히 드러나지 않습니다.',
  };
  const categoryTemplates = {
    도서리뷰: {
      dia_depth: '책 내용 요약은 있지만 독서 중 떠오른 장면, 내 일상 적용, 읽기 전후 관점 변화가 부족합니다.',
      crank_content: '줄거리보다 독자가 바로 따라 할 생각 질문과 실행 연결을 더 보강해야 합니다.',
    },
    IT정보와분석: {
      dia_depth: '기능 소개를 넘어 실제 선택 기준, 비교 대상, 적용 비용과 한계를 더 구체화해야 합니다.',
      geo_citation: '공식 문서, 릴리스 노트, 실측 수치 같은 검증 가능한 근거를 더 붙여야 합니다.',
    },
    최신IT트렌드: {
      dia_depth: '뉴스 요약보다 왜 지금 중요한지, 누가 영향을 받는지, 다음 행동 기준을 더 분명히 해야 합니다.',
      geo_citation: '트렌드 근거가 되는 발표·통계·원문 링크성 정보를 더 명확히 남겨야 합니다.',
    },
    홈페이지와App: {
      dia_depth: 'UI 현상 설명을 넘어 사용자 흐름, 이탈 지점, 개선 전후 예시를 더 구체화해야 합니다.',
    },
  };
  const categoryLesson = categoryTemplates[category]?.[lowest.axis];
  return `${lowest.axis} ${score}: ${categoryLesson || templates[lowest.axis] || '가장 낮은 세부 축을 보완해야 합니다.'} (${title.slice(0, 48)})`;
}

function classifyTitlePattern(title = '') {
  const text = normalizeText(title);
  for (const item of TITLE_PATTERNS) {
    if (item.pattern.test(text)) return item;
  }
  return { key: 'default', label: '기본형' };
}

function buildTitlePatternSummary(rows = [], { threshold = 0.3 } = {}) {
  const counts = new Map();
  for (const row of rows || []) {
    const classified = classifyTitlePattern(row.title || '');
    counts.set(classified.key, {
      key: classified.key,
      label: classified.label,
      count: Number(counts.get(classified.key)?.count || 0) + 1,
    });
  }
  const total = Math.max(0, rows.length);
  const patterns = [...counts.values()]
    .map((item) => ({ ...item, ratio: total > 0 ? item.count / total : 0 }))
    .sort((left, right) => right.count - left.count);
  const top = patterns[0] || null;
  const lesson = top && total > 0 && top.ratio >= threshold && top.key !== 'default'
    ? `최근 ${Math.round(top.ratio * 100)}%가 ${top.label} 제목입니다. 질문형·경험서사형·대비형으로 분산해 제목 피로도를 낮추세요.`
    : '';
  return { total, patterns, top, lesson };
}

async function maybePolishLessonsWithLlm(lessons = [], { callLlm = callHubLlm, enabled = false } = {}) {
  if (!enabled || !lessons.length) return lessons;
  try {
    const result = await callLlm({
      callerTeam: 'blog',
      agent: 'crank-diagnoser',
      selectorKey: 'blog.feedback.analyze',
      taskType: 'blog_crank_diagnosis',
      runtimePurpose: 'blog_feedback_loop',
      systemPrompt: '블로그 C-Rank 진단 lesson을 구체적이고 짧은 한국어 한 줄로 다듬어라. JSON 배열만 출력한다.',
      prompt: JSON.stringify(lessons.map((item) => ({
        post_id: item.post_id,
        axis: item.axis,
        score: item.score,
        title: item.title,
        lesson: item.lesson,
      }))),
      maxTokens: 900,
    });
    const match = String(result?.text || '').match(/\[[\s\S]*\]/);
    const parsed = match ? JSON.parse(match[0]) : JSON.parse(String(result?.text || '[]'));
    if (!Array.isArray(parsed)) return lessons;
    return lessons.map((item, index) => ({
      ...item,
      lesson: normalizeText(parsed[index]?.lesson || parsed[index] || item.lesson),
      lessonSource: 'llm_polished',
    }));
  } catch {
    return lessons;
  }
}

function buildCrankDiagnosisLessons(rows = [], options = {}) {
  const lessons = [];
  for (const row of rows || []) {
    const lowest = selectLowestAxis(row);
    lessons.push({
      post_id: row.post_id,
      postId: row.post_id,
      title: normalizeText(row.title || ''),
      category: normalizeCategory(row),
      postType: row.post_type || null,
      writer: inferWriter(row),
      axis: lowest.axis,
      score: lowest.score,
      overall: Number(row.overall || 0),
      scoredDate: row.scored_date || null,
      lesson: ruleLessonForAxis(row, lowest),
      format_version: WRITING_LEARNINGS_FORMAT_VERSION,
      lessonSource: 'rule',
    });
  }
  const titleRows = Array.isArray(options.titleRows) ? options.titleRows : rows;
  const titleSummary = buildTitlePatternSummary(titleRows, options);
  if (titleSummary.lesson) {
    lessons.push({
      post_id: null,
      postId: null,
      title: 'recent title pattern diversity',
      category: 'all',
      postType: null,
      writer: 'all',
      axis: 'title_diversity',
      score: Math.round((titleSummary.top?.ratio || 0) * 100),
      overall: null,
      scoredDate: null,
      lesson: titleSummary.lesson,
      format_version: WRITING_LEARNINGS_FORMAT_VERSION,
      lessonSource: 'title_pattern_rule',
      titlePatternSummary: titleSummary,
    });
  }
  return lessons;
}

async function fetchRecentCrankRows({ limit = 10, days = 30, pool = pgPool } = {}) {
  return pool.query('blog', `
    WITH latest AS (
      SELECT DISTINCT ON (cs.post_id)
        cs.post_id,
        p.title,
        p.category,
        p.post_type,
        cs.scored_date,
        cs.overall,
        cs.crank_context,
        cs.crank_content,
        cs.crank_chain,
        cs.crank_creator,
        cs.dia_intent,
        cs.dia_depth,
        cs.dia_uniqueness,
        cs.geo_ai,
        cs.geo_structure,
        cs.geo_citation
      FROM blog.crank_scores cs
      JOIN blog.posts p ON p.id = cs.post_id
      WHERE cs.scored_date >= CURRENT_DATE - ($1::text || ' days')::interval
      ORDER BY cs.post_id, cs.scored_date DESC, cs.id DESC
    )
    SELECT *
    FROM latest
    ORDER BY overall ASC, scored_date DESC
    LIMIT $2
  `, [Math.max(1, Number(days || 30)), Math.max(1, Number(limit || 10))]);
}

async function fetchRecentTitleRows({ titleLimit = DEFAULT_TITLE_LIMIT, days = 30, pool = pgPool } = {}) {
  return pool.query('blog', `
    SELECT
      p.id AS post_id,
      p.title,
      p.category,
      p.post_type,
      p.publish_date,
      p.created_at
    FROM blog.posts p
    WHERE COALESCE(p.publish_date::timestamptz, p.created_at) >= CURRENT_DATE - ($1::text || ' days')::interval
      AND COALESCE(p.title, '') <> ''
    ORDER BY COALESCE(p.publish_date::timestamptz, p.created_at) DESC, p.id DESC
    LIMIT $2
  `, [
    Math.max(1, Number(days || 30)),
    Math.max(1, Number(titleLimit || DEFAULT_TITLE_LIMIT)),
  ]);
}

function buildCrankDiagnosisEventPayload(lesson = {}) {
  return {
    post_id: lesson.post_id ?? null,
    axis: lesson.axis,
    score: lesson.score,
    lesson: lesson.lesson,
    writer: lesson.writer,
    format_version: WRITING_LEARNINGS_FORMAT_VERSION,
    title: lesson.title || null,
    category: lesson.category || null,
    overall: lesson.overall ?? null,
    scored_date: lesson.scoredDate || null,
    source: lesson.lessonSource || 'rule',
  };
}

async function recordCrankDiagnosisEvents(lessons = [], { pool = pgPool, runId = null } = {}) {
  const id = runId || crypto.randomUUID();
  const session = await pool.run('blog', `
    INSERT INTO blog.ai_feedback_sessions (
      company_id, user_id, source_type, source_ref_type, source_ref_id,
      flow_code, action_code, proposal_id, ai_input_payload, ai_output_type,
      original_snapshot_json, feedback_status
    )
    VALUES (
      'blog', 1, 'blog_crank_diagnoser', 'crank_score_batch', $1,
      'blog_remodel_bls1', 'diagnose_crank_lessons', $1, $2::jsonb,
      'crank_diagnosis_lessons', $3::jsonb, 'committed'
    )
    RETURNING id
  `, [
    id,
    JSON.stringify({ format_version: WRITING_LEARNINGS_FORMAT_VERSION, lesson_count: lessons.length }),
    JSON.stringify({ lessons: lessons.map(buildCrankDiagnosisEventPayload) }),
  ]);
  const sessionId = session?.rows?.[0]?.id || session?.[0]?.id;
  for (const lesson of lessons) {
    const payload = buildCrankDiagnosisEventPayload(lesson);
    await pool.run('blog', `
      INSERT INTO blog.ai_feedback_events (
        feedback_session_id, event_type, field_key, after_value_json, event_meta_json
      )
      VALUES ($1, 'crank_diagnosis', $2, $3::jsonb, $3::jsonb)
    `, [sessionId, lesson.axis, JSON.stringify(payload)]);
  }
  return { ok: true, runId: id, sessionId, inserted: lessons.length };
}

async function summarizeRecentCrankDiagnosisEvents({ days = 30, limit = 5, pool = pgPool } = {}) {
  try {
    const rows = await pool.query('blog', `
      SELECT
        field_key AS axis,
        COUNT(*)::int AS count,
        (array_agg(event_meta_json->>'lesson' ORDER BY created_at DESC))[1] AS latest_lesson
      FROM blog.ai_feedback_events
      WHERE event_type = 'crank_diagnosis'
        AND event_meta_json->>'format_version' = $1
        AND created_at >= NOW() - ($2::text || ' days')::interval
      GROUP BY field_key
      ORDER BY count DESC, axis ASC
      LIMIT $3
    `, [WRITING_LEARNINGS_FORMAT_VERSION, Math.max(1, Number(days || 30)), Math.max(1, Number(limit || 5))]);
    return rows || [];
  } catch {
    return [];
  }
}

async function runCrankDiagnoser(options = {}) {
  const rows = options.rows || await fetchRecentCrankRows(options);
  const titleRows = options.titleRows || (options.rows ? rows : await fetchRecentTitleRows(options));
  const writerModelCrankComparison = options.writerModelCrankComparison
    || await buildWriterModelCrankComparisonFromDb({ ...options, rows: options.writerModelRows });
  let lessons = buildCrankDiagnosisLessons(rows, { ...options, titleRows });
  lessons = await maybePolishLessonsWithLlm(lessons, { enabled: Boolean(options.useLlm), callLlm: options.callLlm || callHubLlm });
  let writeResult = null;
  let learningsResult = null;
  if (options.write === true) {
    writeResult = await recordCrankDiagnosisEvents(lessons, options);
    learningsResult = appendWritingLearningsSummary({ lessons });
  }
  return {
    ok: true,
    dryRun: options.write !== true,
    formatVersion: WRITING_LEARNINGS_FORMAT_VERSION,
    rows: rows.length,
    titleRows: titleRows.length,
    writerModelCrankComparison,
    lessons,
    writeResult,
    learningsResult,
  };
}

module.exports = {
  DETAIL_AXES,
  TITLE_PATTERNS,
  DEFAULT_TITLE_LIMIT,
  inferWriter,
  normalizeCategory,
  selectLowestAxis,
  ruleLessonForAxis,
  classifyTitlePattern,
  buildTitlePatternSummary,
  buildCrankDiagnosisLessons,
  buildCrankDiagnosisEventPayload,
  recordCrankDiagnosisEvents,
  summarizeRecentCrankDiagnosisEvents,
  buildWriterModelCrankComparisonFromDb,
  fetchRecentCrankRows,
  fetchRecentTitleRows,
  runCrankDiagnoser,
};
