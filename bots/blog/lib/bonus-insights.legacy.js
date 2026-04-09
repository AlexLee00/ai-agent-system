'use strict';

/**
 * bonus-insights.js — 봇별 보너스 인사이트 풀 + 랜덤 선택
 *
 * 구조:
 *   기존 인사이트 ①②③④ 고정 4개 유지
 *   + 보너스 0~2개 랜덤 추가 → 총 4~6개
 *
 * 확률: 0개 40% / 1개 35% / 2개 25%
 */

const POS_BONUS_POOL = [
  {
    id: 'real_case',
    title: '[실전 사례 분석]',
    instruction: '실제 ai-agent-system 프로젝트에서 겪은 구체적 에피소드. "제가 직접 운영하는 시스템에서..." 형태로 500자+',
    minChars: 500,
  },
  {
    id: 'common_mistakes',
    title: '[입문자가 자주 하는 실수 TOP 3]',
    instruction: '해당 강의 주제에서 입문자가 자주 하는 실수 3가지와 해결법. 코드 예시 포함 500자+',
    minChars: 500,
  },
  {
    id: 'interview_prep',
    title: '[기술 면접 핵심 질문]',
    instruction: '이 강의 주제가 기술 면접에 나올 때 자주 묻는 질문 3개 + 모범 답변 요약 500자+',
    minChars: 500,
  },
  {
    id: 'performance_deep',
    title: '[성능 최적화 딥다이브]',
    instruction: '이 기술을 실무에서 최적화하는 고급 기법. 벤치마크 수치와 함께 설명 500자+',
    minChars: 500,
  },
  {
    id: 'comparison',
    title: '[기술 비교 분석표]',
    instruction: '유사 기술/도구와의 비교 테이블. 장단점 + "결론" 행 포함. GEO용 500자+',
    minChars: 500,
  },
  {
    id: 'history',
    title: '[기술 발전 타임라인]',
    instruction: '해당 기술의 탄생부터 현재까지 주요 마일스톤. 역사적 맥락 제공 400자+',
    minChars: 400,
  },
];

const GEMS_BONUS_POOL = [
  {
    id: 'trend_analysis',
    title: '[트렌드 인사이트]',
    instruction: '이 주제의 2025~2026년 최신 트렌드와 전망. 시장 데이터나 사례 인용 500자+',
    minChars: 500,
  },
  {
    id: 'business_impact',
    title: '[비즈니스 임팩트 분석]',
    instruction: '이 기술이 비즈니스에 미치는 구체적 영향. ROI 관점. 카페 운영 경험 연결 500자+',
    minChars: 500,
  },
  {
    id: 'beginner_guide',
    title: '[완전 초보를 위한 한줄 요약]',
    instruction: '전문 용어 없이 초등학생도 이해할 수 있게 핵심 개념 풀어쓰기. 비유 활용 400자+',
    minChars: 400,
  },
  {
    id: 'tool_recommend',
    title: '[추천 도구 & 리소스]',
    instruction: '해당 주제를 공부하거나 실무에 적용할 때 유용한 도구, 사이트, 강좌 추천 400자+',
    minChars: 400,
  },
  {
    id: 'real_numbers',
    title: '[숫자로 보는 팩트]',
    instruction: '해당 기술/주제의 통계 수치, 시장 규모, 채택률 등 데이터 기반 분석 500자+',
    minChars: 500,
  },
  {
    id: 'future_outlook',
    title: '[미래 전망 — 3년 후]',
    instruction: '이 기술/주제가 3년 후 어떻게 변할지 예측. 근거와 함께 전문가적 시각 제공 500자+',
    minChars: 500,
  },
];

const STAR_BONUS_POOL = [
  {
    id: 'quick_tip',
    title: '[오늘의 꿀팁]',
    instruction: '이 주제에서 바로 써먹을 수 있는 실용적 팁 1개. 인스타 카드에 쓰기 좋은 임팩트 문장 300자+',
    minChars: 300,
  },
  {
    id: 'before_after',
    title: '[Before → After]',
    instruction: '이 기술 적용 전후 비교. 시각적으로 대비되는 구성. 인스타 카드 소재 300자+',
    minChars: 300,
  },
  {
    id: 'one_line_summary',
    title: '[한줄 핵심 정리]',
    instruction: '이 주제를 한 문장으로 정리. 인스타 캡션의 첫 줄로 사용 가능한 임팩트 있는 문장 200자+',
    minChars: 200,
  },
  {
    id: 'myth_buster',
    title: '[오해와 진실]',
    instruction: '이 주제에 대한 흔한 오해 1~2개와 실제 진실. 인스타 카드 "알고 계셨나요?" 형태 300자+',
    minChars: 300,
  },
];

function selectBonusInsights(botType, recentHistory = []) {
  const pool = botType === 'pos'  ? POS_BONUS_POOL
             : botType === 'gems' ? GEMS_BONUS_POOL
             :                      STAR_BONUS_POOL;

  const rand  = Math.random();
  const count = botType === 'gems'
    ? (rand < 0.20 ? 0 : rand < 0.60 ? 1 : 2)
    : (rand < 0.40 ? 0 : rand < 0.75 ? 1 : 2);
  if (count === 0) return [];

  const usedIds   = new Set(recentHistory);
  const available = pool.filter(b => !usedIds.has(b.id));
  const source    = available.length >= count ? available : pool;

  const shuffled = [...source].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, count);

  const insertPositions = ['after_insight_1', 'after_insight_2', 'after_insight_3', 'after_insight_4'];
  const positions = [...insertPositions].sort(() => Math.random() - 0.5);

  return selected.map((bonus, i) => ({
    ...bonus,
    insertAfter: positions[i] || 'after_insight_3',
  }));
}

module.exports = {
  POS_BONUS_POOL,
  GEMS_BONUS_POOL,
  STAR_BONUS_POOL,
  selectBonusInsights,
};
