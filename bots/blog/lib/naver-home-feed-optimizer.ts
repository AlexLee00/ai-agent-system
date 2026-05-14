// @ts-nocheck
'use strict';
/**
 * 네이버 홈판(홈피드) + 다양한 노출 최적화 — I영역 (CODEX_BLOG_NEURAL_QUALITY_BOOST_V2)
 *
 * 네이버 8가지 노출 채널:
 *  ① 홈판(홈피드) — AI 개인화 추천 (가장 핵심!)
 *  ② 스마트 블록(에어서치) — 검색 의도 매칭
 *  ③ 키워드 검색 — C-Rank + D.I.A+
 *  ④ 이웃 알림
 *  ⑤ 인플루언서 추천
 *  ⑥ 모먼트
 *  ⑦ 카페 연결
 *  ⑧ 뉴스/이슈 연동
 */

const path    = require('path');
const env     = require('../../../packages/core/lib/env');
const { callHubLlm } = require('../../../packages/core/lib/hub-client');
const pgPool  = require('../../../packages/core/lib/pg-pool');
const { ensureBlogV3Tables } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/blog-v3-unified.ts'));

// ── 홈판 제목 평가 기준 ────────────────────────────────────────────────────────

const TITLE_HOOKS = [
  { pattern: /\d+가지|\d+개|\d+초|\d+분|\d+배/, label: '숫자 포함', score: 20 },
  { pattern: /충격|놀라운|반전|비밀|몰랐던|꿀팁|혜자/, label: '감정 유발', score: 15 },
  { pattern: /\?$/, label: '질문형 제목', score: 10 },
  { pattern: /이유|방법|하는법|하는방법/, label: '솔루션형', score: 12 },
  { pattern: /2026|최신|신상|업데이트|새로운/, label: '시의성', score: 10 },
  { pattern: /[가-힣]{2,4}\s*(추천|TOP|랭킹|순위)/, label: '랭킹형', score: 8 },
  { pattern: /완전정복|마스터|정리|요약|핵심/, label: '정보 압축', score: 10 },
];

const TITLE_ANTIPATTERNS = [
  { pattern: /^안녕하세요/, label: '인사형 시작', score: -15 },
  { pattern: /^오늘은/, label: '일기형 시작', score: -10 },
  { pattern: /기초.*완성|완성.*기초/, label: '진부한 표현', score: -8 },
  { pattern: /.{40,}/, label: '제목 너무 길음 (40자+)', score: -10 },
  { pattern: /^.{1,8}$/, label: '제목 너무 짧음 (8자-)', score: -8 },
];

/**
 * 제목 홈판 점수 계산 (0-100)
 */
export function scoreTitleForHomeFeed(title: string): {
  score: number;
  hits: string[];
  misses: string[];
  recommendation: string;
} {
  let score = 40; // 기본 점수
  const hits: string[] = [];
  const misses: string[] = [];

  // 긍정 패턴 검사
  for (const h of TITLE_HOOKS) {
    if (h.pattern.test(title)) {
      score += h.score;
      hits.push(`+${h.score} ${h.label}`);
    }
  }

  // 부정 패턴 검사
  for (const a of TITLE_ANTIPATTERNS) {
    if (a.pattern.test(title)) {
      score += a.score;
      misses.push(`${a.score} ${a.label}`);
    }
  }

  // 길이 보너스 (28-32자 최적)
  const len = title.length;
  if (len >= 28 && len <= 32) {
    score += 10;
    hits.push('+10 최적 제목 길이 (28-32자)');
  } else if (len >= 20 && len < 28) {
    score += 5;
    hits.push('+5 양호한 제목 길이');
  }

  score = Math.max(0, Math.min(100, score));

  let recommendation = '';
  if (score >= 80) {
    recommendation = '홈판 최적화 우수';
  } else if (score >= 60) {
    recommendation = '홈판 노출 가능 (숫자/감정 단어 추가 시 개선)';
  } else {
    recommendation = '홈판 노출 낮음 — 제목 개선 필요';
  }

  return { score, hits, misses, recommendation };
}

// ── 첫 문단 후크 평가 ─────────────────────────────────────────────────────────

/**
 * 첫 문단 후크 강도 평가 (0-100)
 */
export function scoreFirstParagraphHook(content: string): {
  score: number;
  firstParagraph: string;
  issues: string[];
} {
  const lines = content.split('\n').filter(l => l.trim().length > 0);
  const firstParagraph = lines.slice(0, 5).join('\n');
  const issues: string[] = [];
  let score = 50;

  // 후크 신호 확인
  if (/\?/.test(firstParagraph)) {
    score += 15;
  } else {
    issues.push('첫 문단에 질문 없음 (독자 관심 유도 약함)');
  }

  if (firstParagraph.length < 100) {
    score -= 10;
    issues.push('첫 문단 너무 짧음 (100자 이상 권장)');
  } else if (firstParagraph.length > 300) {
    score -= 5;
    issues.push('첫 문단 너무 길음 (300자 이내 권장)');
  }

  if (/충격|놀랍|반전|비밀|사실|실제로|솔직히/.test(firstParagraph)) {
    score += 10;
  }

  if (/저도|제가|저는|저한테/.test(firstParagraph)) {
    score += 10; // 개인적 관점
  }

  // 핵심 가치 즉시 제시 확인
  if (/핵심|중요|이유|방법|비결|비밀/.test(firstParagraph)) {
    score += 10;
  }

  score = Math.max(0, Math.min(100, score));
  return { score, firstParagraph, issues };
}

// ── 해시태그 전략 ─────────────────────────────────────────────────────────────

/**
 * 최적 해시태그 세트 생성 (3-7개)
 */
export async function generateOptimalHashtags(
  title: string,
  category: string,
  content: string
): Promise<string[]> {
  const prompt = `블로그 포스팅의 최적 해시태그를 선정하세요.

제목: ${title}
카테고리: ${category}
내용 요약: ${content.substring(0, 300)}

조건:
- 3-7개 (과다 X)
- 메인 키워드 1-2개 (핵심 토픽)
- 서브 키워드 2-3개 (관련)
- 트렌드 태그 1개 (시의성)
- 모두 한국어로

결과는 해시태그 배열만 JSON으로 반환:
["#키워드1", "#키워드2", ...]`;

  try {
    const response = await callHubLlm({
      callerTeam: 'blog',
      agent: 'social-caption',
      selectorKey: 'blog.social.caption',
      taskType: 'home_feed_hashtags',
      prompt,
      maxTokens: 200,
      temperature: 0.3,
      timeoutMs: 45_000,
      maxBudgetUsd: 0.03,
    });

    const text = response?.text || response?.result || '';
    const match = text.match(/\[.*?\]/s);
    if (match) {
      const tags = JSON.parse(match[0]);
      return Array.isArray(tags) ? tags.slice(0, 7) : [];
    }
  } catch (e: any) {
    console.warn('[홈판최적화] 해시태그 생성 실패:', e.message);
  }

  // 폴백 해시태그
  return [`#${category}`, '#2026트렌드', '#일상', '#정보'];
}

// ── 노출 채널별 체크리스트 ────────────────────────────────────────────────────

export interface ExposureAudit {
  channel: string;
  score: number;          // 0-100
  enabled: boolean;
  actions: string[];      // 개선 필요 액션
}

/**
 * 8가지 노출 채널 감사
 */
export function auditExposureChannels(params: {
  title: string;
  content: string;
  category: string;
  hasImages: boolean;
  wordCount: number;
  hashtagCount: number;
}): ExposureAudit[] {
  const { title, content, category, hasImages, wordCount, hashtagCount } = params;
  const titleScore = scoreTitleForHomeFeed(title);
  const hookScore = scoreFirstParagraphHook(content);

  return [
    {
      channel: '홈판(홈피드)',
      score: Math.round((titleScore.score + hookScore.score) / 2),
      enabled: true,
      actions: [
        ...(titleScore.score < 70 ? ['제목 개선: 숫자/감정 단어 추가'] : []),
        ...(hookScore.score < 70 ? ['첫 문단 후크 강화'] : []),
        ...(wordCount < 1000 ? ['본문 최소 1,000자 이상'] : []),
        ...(!hasImages ? ['썸네일 이미지 추가 (홈판 미리보기 핵심)'] : []),
      ],
    },
    {
      channel: '스마트블록(에어서치)',
      score: /[가-힣]{2,10}\s*(방법|이유|하는법|란|이란|뜻|차이)/.test(title) ? 80 : 50,
      enabled: true,
      actions: [
        ...(!(/방법|이유|하는법|이란|뜻/.test(title)) ? ['검색 의도 키워드 추가 (방법/이유/하는법)'] : []),
        ...(wordCount < 800 ? ['정보 밀도 높이기 (800자+ 권장)'] : []),
      ],
    },
    {
      channel: '키워드 검색',
      score: wordCount >= 1500 ? 80 : wordCount >= 1000 ? 65 : 40,
      enabled: true,
      actions: [
        ...(wordCount < 1500 ? [`본문 ${1500 - wordCount}자 추가 (C-Rank 최적화)`] : []),
        ...(!(/IT|기술|코딩|투자|건강|여행|맛집/.test(category)) ? ['전문 카테고리 집중 (C-Rank 주제 점수)'] : []),
      ],
    },
    {
      channel: '이웃 알림',
      score: 70,
      enabled: true,
      actions: ['이웃 맺기 활성화', '댓글/공감 활동 유지'],
    },
    {
      channel: '해시태그',
      score: hashtagCount >= 3 && hashtagCount <= 7 ? 85 : hashtagCount === 0 ? 10 : 60,
      enabled: hashtagCount > 0,
      actions: [
        ...(hashtagCount === 0 ? ['해시태그 3-7개 추가'] : []),
        ...(hashtagCount > 7 ? [`해시태그 ${hashtagCount - 7}개 줄이기`] : []),
      ],
    },
    {
      channel: '인플루언서',
      score: 30,
      enabled: false,
      actions: ['네이버 인플루언서 등록 (조건: 이웃 1,000+ 또는 누적 조회 10만+)'],
    },
    {
      channel: '모먼트',
      score: 0,
      enabled: false,
      actions: ['모먼트 활성화 예정 (별도 설정 필요)'],
    },
    {
      channel: '뉴스/이슈 연동',
      score: /2026|최신|신상|트렌드|이슈/.test(title) ? 60 : 20,
      enabled: true,
      actions: [
        ...(!(/2026|최신|트렌드|이슈/.test(title)) ? ['시의성 키워드 추가 (뉴스 연동 가능성 ↑)'] : []),
      ],
    },
  ];
}

// ── 체류 시간 예측 ────────────────────────────────────────────────────────────

/**
 * 예상 체류 시간 계산 (초)
 * 평균 읽기 속도: 한국어 300자/분
 */
export function estimateDwellTime(content: string): {
  estimatedSeconds: number;
  rating: 'excellent' | 'good' | 'fair' | 'poor';
  target: string;
} {
  const charCount = content.replace(/\s+/g, '').length;
  const readingSeconds = Math.round((charCount / 300) * 60);

  // 이미지/목록은 체류 시간 추가 (각 약 5초)
  const imageCount = (content.match(/!\[.*?\]/g) || []).length;
  const listItemCount = (content.match(/^[-*•]\s/gm) || []).length;
  const bonusSeconds = imageCount * 5 + listItemCount * 2;

  const totalSeconds = readingSeconds + bonusSeconds;

  let rating: 'excellent' | 'good' | 'fair' | 'poor';
  if (totalSeconds >= 120) rating = 'excellent';
  else if (totalSeconds >= 90) rating = 'good';
  else if (totalSeconds >= 60) rating = 'fair';
  else rating = 'poor';

  return {
    estimatedSeconds: totalSeconds,
    rating,
    target: '목표: 90초+ (홈판 추천 임계값)',
  };
}

// ── 통합 홈판 최적화 리포트 ──────────────────────────────────────────────────

export async function generateHomeFeedReport(params: {
  title: string;
  content: string;
  category: string;
  hasImages?: boolean;
}): Promise<{
  titleScore: ReturnType<typeof scoreTitleForHomeFeed>;
  hookScore: ReturnType<typeof scoreFirstParagraphHook>;
  dwellTime: ReturnType<typeof estimateDwellTime>;
  channels: ExposureAudit[];
  overallScore: number;
  topActions: string[];
}> {
  const { title, content, category, hasImages = false } = params;
  const wordCount = content.replace(/\s+/g, '').length;
  const hashtagCount = (content.match(/#[가-힣a-zA-Z\w]+/g) || []).length;

  const titleScore = scoreTitleForHomeFeed(title);
  const hookScore = scoreFirstParagraphHook(content);
  const dwellTime = estimateDwellTime(content);
  const channels = auditExposureChannels({ title, content, category, hasImages, wordCount, hashtagCount });

  const overallScore = Math.round(
    (titleScore.score * 0.35) +
    (hookScore.score * 0.25) +
    (dwellTime.estimatedSeconds >= 90 ? 100 : (dwellTime.estimatedSeconds / 90) * 100) * 0.20 +
    (channels[0].score * 0.20)  // 홈판 채널 점수
  );

  // 최우선 개선 액션 (5개 이하)
  const allActions = channels.flatMap(c => c.actions);
  const topActions = [...new Set([
    ...titleScore.hits.length < 3 ? ['제목: 숫자 또는 감정 단어 추가'] : [],
    ...hookScore.score < 70 ? ['첫 문단: 질문 또는 개인 경험으로 시작'] : [],
    ...dwellTime.rating === 'poor' ? ['본문 1,000자 이상으로 확장'] : [],
    ...!hasImages ? ['썸네일 이미지 추가'] : [],
    ...allActions.slice(0, 3),
  ])].slice(0, 5);

  return { titleScore, hookScore, dwellTime, channels, overallScore, topActions };
}

export async function recordHomeFeedAudit(params: {
  postId?: number | null;
  title: string;
  category?: string | null;
  report: Awaited<ReturnType<typeof generateHomeFeedReport>>;
  dryRun?: boolean;
  shadowOnly?: boolean;
}): Promise<{ ok: boolean; dryRun: boolean; inserted: number }> {
  if (params.dryRun) return { ok: true, dryRun: true, inserted: 0 };
  await ensureBlogV3Tables();
  const result = await pgPool.run('blog', `
    INSERT INTO blog.naver_exposure_audits
      (post_id, title, category, overall_score, title_score, hook_score, dwell_seconds, channels, top_actions, shadow_only)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING id
  `, [
    params.postId || null,
    params.title,
    params.category || null,
    params.report.overallScore || 0,
    params.report.titleScore?.score || 0,
    params.report.hookScore?.score || 0,
    params.report.dwellTime?.estimatedSeconds || 0,
    JSON.stringify(params.report.channels || []),
    JSON.stringify(params.report.topActions || []),
    params.shadowOnly !== false,
  ]);
  return { ok: true, dryRun: false, inserted: result?.rowCount || 0 };
}
