// @ts-nocheck
'use strict';

const pgPool = require('../../../packages/core/lib/pg-pool');
const { callBlogFast } = require('./blog-llm-gateway.ts');
const { isReaderFriendlyTitle } = require('./topic-selector.ts');
const { checkBlogFormatRules, checkGeneralTitleAlignment, scoreSEO } = require('./quality-checker.ts');
const { _assertDistinctGeneralTitle } = require('./gems-writer.ts');

const DEFAULT_DAYS = 30;
const PROFILE_CACHE_MS = 30 * 60 * 1000;
const SEO_LEVEL_RANK = { poor: 0, fair: 1, good: 2 };
const FEATURE_DEFINITIONS = [
  { key: 'length_1_20', matches: (title) => title.length <= 20 },
  { key: 'length_21_30', matches: (title) => title.length >= 21 && title.length <= 30 },
  { key: 'length_31_40', matches: (title) => title.length >= 31 && title.length <= 40 },
  { key: 'length_41_50', matches: (title) => title.length >= 41 && title.length <= 50 },
  { key: 'length_51_plus', matches: (title) => title.length >= 51 },
  { key: 'has_number', matches: (title) => /\d/.test(title) },
  { key: 'question_style', matches: (title) => /[?？]/u.test(title) },
  { key: 'hands_on', matches: (title) => /(실전|직접|해보니|써보니|실패|체크리스트|점검표)/u.test(title) },
  { key: 'decision_terms', matches: (title) => /(기준|판단|비교|정리|방법|하는 법)/u.test(title) },
  { key: 'two_part', matches: (title) => /[:,—-]/u.test(title) },
];

const cachedProfiles = new Map();

function stripCategoryPrefix(title = '') {
  return String(title || '').replace(/^\[[^\]]+\]\s*/, '').trim();
}

function average(values = []) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length;
}

function extractTitleFeatures(title = '') {
  const normalizedTitle = stripCategoryPrefix(title);
  return Object.fromEntries(
    FEATURE_DEFINITIONS.map((feature) => [feature.key, feature.matches(normalizedTitle)])
  );
}

function summarizeTitleFeatureCorrelations(rows = [], options = {}) {
  const minSamplesPerSide = Math.max(1, Number(options.minSamplesPerSide || 5));
  const minAbsoluteDelta = Math.max(0, Number(options.minAbsoluteDelta ?? 1.5));
  const normalizedRows = (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      title: String(row?.title || '').trim(),
      crankTotal: Number(row?.crank_total ?? row?.crankTotal),
    }))
    .filter((row) => row.title && Number.isFinite(row.crankTotal));
  const features = {};

  for (const definition of FEATURE_DEFINITIONS) {
    const withFeature = normalizedRows
      .filter((row) => definition.matches(stripCategoryPrefix(row.title)))
      .map((row) => row.crankTotal);
    const withoutFeature = normalizedRows
      .filter((row) => !definition.matches(stripCategoryPrefix(row.title)))
      .map((row) => row.crankTotal);
    const delta = average(withFeature) - average(withoutFeature);
    const eligible = withFeature.length >= minSamplesPerSide
      && withoutFeature.length >= minSamplesPerSide
      && Math.abs(delta) >= minAbsoluteDelta;

    features[definition.key] = {
      with_count: withFeature.length,
      with_average: Number(average(withFeature).toFixed(2)),
      without_count: withoutFeature.length,
      without_average: Number(average(withoutFeature).toFixed(2)),
      delta: Number(delta.toFixed(2)),
      eligible,
    };
  }

  return {
    days: Math.max(1, Number(options.days || DEFAULT_DAYS)),
    sample_size: normalizedRows.length,
    min_samples_per_side: minSamplesPerSide,
    min_absolute_delta: minAbsoluteDelta,
    eligible_features: Object.entries(features)
      .filter(([, feature]) => feature.eligible)
      .map(([key]) => key),
    features,
  };
}

async function loadTitleCorrelationProfile(options = {}) {
  const days = Math.max(1, Number(options.days || DEFAULT_DAYS));
  const category = String(options.category || '').trim();
  const pool = options.pool || pgPool;
  const now = Date.now();
  const cacheKey = `${days}:${category || 'global'}`;
  const cachedProfile = cachedProfiles.get(cacheKey);
  if (!options.noCache && cachedProfile && now - cachedProfile.loadedAt < PROFILE_CACHE_MS) {
    return cachedProfile.profile;
  }

  const rows = await pool.query('blog', `
    WITH ranked AS (
      SELECT
        cs.post_id,
        cs.crank_total,
        p.title,
        p.category,
        ROW_NUMBER() OVER (
          PARTITION BY cs.post_id
          ORDER BY cs.scored_date DESC, cs.id DESC
        ) AS row_number
      FROM blog.crank_scores cs
      JOIN blog.posts p ON p.id = cs.post_id
      WHERE cs.scored_date >= CURRENT_DATE - ($1::text || ' days')::interval
        AND p.post_type = 'general'
    )
    SELECT post_id, title, category, crank_total
    FROM ranked
    WHERE row_number = 1
  `, [String(days)]);
  const globalProfile = summarizeTitleFeatureCorrelations(rows, { ...options, days });
  const categoryProfile = category
    ? summarizeTitleFeatureCorrelations(
      rows.filter((row) => String(row?.category || '').trim() === category),
      { ...options, days }
    )
    : null;
  const useCategoryProfile = Boolean(categoryProfile?.eligible_features?.length);
  const profile = {
    ...(useCategoryProfile ? categoryProfile : globalProfile),
    profile_scope: category ? (useCategoryProfile ? 'category' : 'global_fallback') : 'global',
    profile_category: category || null,
  };
  if (!options.noCache) cachedProfiles.set(cacheKey, { loadedAt: now, profile });
  return profile;
}

function cleanGeneratedTitle(value = '') {
  return stripCategoryPrefix(String(value || ''))
    .replace(/^#{1,6}\s*/, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim();
}

function normalizeCandidates(candidates = [], { category = '', baseTitle = '', requiredPhrase = '' } = {}) {
  const seen = new Set();
  const values = [baseTitle, ...(Array.isArray(candidates) ? candidates : [])];
  const normalized = [];

  for (const candidate of values) {
    const rawTitle = typeof candidate === 'string' ? candidate : candidate?.title;
    const cleanTitle = cleanGeneratedTitle(rawTitle);
    if (!cleanTitle || seen.has(cleanTitle)) continue;
    if (!isReaderFriendlyTitle(cleanTitle, category)) continue;
    if (requiredPhrase && !cleanTitle.includes(requiredPhrase)) continue;
    seen.add(cleanTitle);
    normalized.push(category ? `[${category}] ${cleanTitle}` : cleanTitle);
    if (normalized.length >= 5) break;
  }

  return normalized;
}

function validateTitleCandidate(title = '', input = {}) {
  const content = replaceTitleLine(input.content, title);
  const format = checkBlogFormatRules(content, 'general', { title });
  const seo = scoreSEO(content, title);
  const baseTitle = String(input.baseTitle || '').trim();
  const baseSeo = scoreSEO(replaceTitleLine(input.content, baseTitle), baseTitle);
  const formatIssues = format.issues.filter((issue) => /^B3 제목/.test(issue.msg));
  const seoIssues = seo.seoIssues.filter((issue) => /^제목/.test(issue));
  const alignmentErrors = checkGeneralTitleAlignment(title, input)
    .filter((issue) => issue.severity === 'error');
  const seoLevelDropped = Number(SEO_LEVEL_RANK[seo.seoLevel] || 0)
    < Number(SEO_LEVEL_RANK[baseSeo.seoLevel] || 0);
  const reasons = [
    ...formatIssues.map((issue) => `format_issue:${issue.msg}`),
    ...seoIssues.map((issue) => `seo_issue:${issue}`),
    ...alignmentErrors.map((issue) => `topic_alignment_error:${issue.msg}`),
    ...(seoLevelDropped ? [`seo_level_drop:${baseSeo.seoLevel}->${seo.seoLevel}`] : []),
  ];
  return {
    passed: reasons.length === 0,
    formatIssues,
    seoIssues,
    alignmentErrors,
    reasons,
  };
}

function parseCandidateResponse(response = '') {
  const text = String(response || '').trim();
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  const parsed = JSON.parse(match[0]);
  return Array.isArray(parsed) ? parsed : [];
}

async function generateTitleCandidates(input = {}) {
  const baseTitle = stripCategoryPrefix(input.baseTitle);
  const requiredPhrase = String(input.requiredPhrase || '').trim();
  const response = await callBlogFast(`다음 블로그 글에 사용할 제목 후보 4개를 만드세요.

카테고리: ${input.category || '일반'}
선택된 주제: ${input.topic || baseTitle}
기존 제목: ${baseTitle}
${requiredPhrase ? `반드시 모든 제목에 포함할 문구: ${requiredPhrase}` : ''}
본문 요약: ${String(input.content || '').replace(/\s+/g, ' ').slice(0, 700)}

규칙:
- 같은 주제를 유지하되 길이, 숫자, 질문형, 구체적 결과 표현을 서로 다르게 구성
- 과장이나 추상어를 피하고 60자 이내
- 카테고리 대괄호는 붙이지 않음
- JSON 문자열 배열만 출력`, {
    agent: 'blo',
    selectorKey: 'blog._default',
    taskType: 'blog_title_candidates',
    maxTokens: 300,
    timeoutMs: 15_000,
    maxBudgetUsd: 0.01,
    temperature: 0.65,
  });
  return parseCandidateResponse(response?.content || response?.text || response?.result || '');
}

function selectTitleCandidate(candidates = [], profile = {}) {
  const eligibleFeatures = new Set(profile?.eligible_features || []);
  const scoredCandidates = candidates.map((title, index) => {
    const features = extractTitleFeatures(title);
    const contributions = [];
    let score = 0;

    for (const featureKey of eligibleFeatures) {
      if (!features[featureKey]) continue;
      const delta = Number(profile?.features?.[featureKey]?.delta || 0);
      score += Math.max(-6, Math.min(6, delta));
      contributions.push(`${featureKey}=${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`);
    }

    return {
      title,
      score: Number(score.toFixed(2)),
      features: Object.entries(features).filter(([, enabled]) => enabled).map(([key]) => key),
      contributions,
      index,
    };
  });
  scoredCandidates.sort((first, second) => second.score - first.score || first.index - second.index);
  const selected = scoredCandidates[0] || null;
  const profileScope = String(profile?.profile_scope || 'global');
  const scopeLabel = profile?.profile_category
    ? `${profileScope}:${profile.profile_category}`
    : profileScope;

  return {
    title: selected?.title || String(candidates[0] || ''),
    reason: `crank30d:scope=${scopeLabel}; n=${Number(profile?.sample_size || 0)}; ${selected?.contributions?.join(', ') || 'no_feature_delta'}; score=${Number(selected?.score || 0).toFixed(2)}`,
    scoredCandidates,
  };
}

function replaceTitleLine(content = '', title = '') {
  const lines = String(content || '').split('\n');
  const titleIndex = lines.findIndex((line) => line.trim().length > 0);
  if (titleIndex < 0) return title;
  lines[titleIndex] = title;
  return lines.join('\n');
}

function fallbackResult(input = {}, reason = 'unknown', rejectedCandidates = []) {
  const baseTitle = String(input.baseTitle || '').trim();
  return {
    title: baseTitle,
    content: replaceTitleLine(input.content, baseTitle),
    metadata: {
      title_candidates: [{ title: baseTitle, score: 0, features: [] }],
      title_rejected_candidates: rejectedCandidates,
      title_selected_reason: `fallback_existing_title:${reason}`,
    },
  };
}

async function runTitleFeedbackLoop(input = {}, dependencies = {}) {
  const generateCandidates = dependencies.generateCandidates || generateTitleCandidates;
  const loadCorrelationProfile = dependencies.loadCorrelationProfile || loadTitleCorrelationProfile;
  const assertDistinctTitle = dependencies.assertDistinctTitle || _assertDistinctGeneralTitle;

  try {
    const generated = await generateCandidates(input);
    const rejectedCandidates = [];
    const candidates = normalizeCandidates(generated, input)
      .filter((title) => {
        const validation = validateTitleCandidate(title, input);
        if (validation.passed) return true;
        rejectedCandidates.push({ title, reasons: validation.reasons });
        return false;
      })
      .filter((title) => {
        try {
          assertDistinctTitle(input.category, title);
          return true;
        } catch (error) {
          rejectedCandidates.push({
            title,
            reasons: [`recent_title_overlap:${String(error?.message || error).slice(0, 120)}`],
          });
          return false;
        }
      });
    if (candidates.length < 3) return fallbackResult(input, 'candidate_count_below_3', rejectedCandidates);

    const profile = await loadCorrelationProfile({ days: DEFAULT_DAYS, category: input.category });
    if (!profile?.eligible_features?.length) return fallbackResult(input, 'no_meaningful_crank_signal', rejectedCandidates);

    const selected = selectTitleCandidate(candidates, profile);
    return {
      title: selected.title,
      content: replaceTitleLine(input.content, selected.title),
      metadata: {
        title_candidates: selected.scoredCandidates.map((candidate) => ({
          title: candidate.title,
          score: candidate.score,
          features: candidate.features,
        })),
        title_rejected_candidates: rejectedCandidates,
        title_selected_reason: selected.reason,
      },
    };
  } catch (error) {
    return fallbackResult(input, `error:${String(error?.message || error).slice(0, 120)}`);
  }
}

module.exports = {
  extractTitleFeatures,
  generateTitleCandidates,
  loadTitleCorrelationProfile,
  normalizeCandidates,
  replaceTitleLine,
  runTitleFeedbackLoop,
  selectTitleCandidate,
  summarizeTitleFeatureCorrelations,
  validateTitleCandidate,
};
