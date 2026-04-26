// @ts-nocheck
'use strict';

const { registerAgent } = require('../../../packages/core/lib/agent-registry');

function runtimeConfig(purpose = 'writer') {
  return { llm_management: 'runtime-managed', runtime_team: 'blog', runtime_purpose: purpose };
}

const BLOG_REINFORCEMENTS = [
  {
    name: 'nero',
    display_name: '네로',
    team: 'blog',
    role: 'writer',
    specialty: '대화형캐주얼작가(~하죠?패턴,친근톤,조회수+체류시간최적화)',
    config: runtimeConfig('writer'),
    dot_character: { color: '#f97316', accessory: 'pen' },
  },
  {
    name: 'socra',
    display_name: '소크라',
    team: 'blog',
    role: 'writer',
    specialty: '질문형탐구작가(왜?로시작,답찾아가는구조,공감수+댓글유도)',
    config: runtimeConfig('writer'),
    dot_character: { color: '#0ea5e9', accessory: 'book' },
  },
  {
    name: 'polish',
    display_name: '폴리쉬',
    team: 'blog',
    role: 'editor',
    specialty: '가독성흐름편집(문장길이조절,단락리듬,전환어,체류시간최적화)',
    config: runtimeConfig('writer'),
    dot_character: { color: '#a855f7', accessory: 'pen' },
  },
  {
    name: 'hooker',
    display_name: '훅커',
    team: 'blog',
    role: 'editor',
    specialty: '제목+도입부특화편집(클릭유도제목,강력한첫3문장,CTA,CTR최적화)',
    config: runtimeConfig('writer'),
    dot_character: { color: '#ef4444', accessory: 'pen' },
  },
  {
    name: 'deepsearch',
    display_name: '딥서치',
    team: 'blog',
    role: 'researcher',
    specialty: '심층리서치전문(arXiv논문+GitHub코드+공식문서정독,전문성최적화)',
    config: runtimeConfig('default'),
    dot_character: { color: '#6366f1', accessory: 'magnifier' },
  },
  {
    name: 'critic',
    display_name: '크리틱',
    team: 'blog',
    role: 'critic',
    specialty: '능동적비판자(논리허점지적,독자반박예측,Writer→Critic루프,31%품질향상)',
    config: runtimeConfig('writer'),
    dot_character: { color: '#dc2626', accessory: 'shield' },
  },
  {
    name: 'voice',
    display_name: '보이스',
    team: 'blog',
    role: 'brand_voice',
    specialty: '브랜드보이스관리(전문적+친근한톤,모든작가결과물톤통일,일관성보장)',
    config: runtimeConfig('writer'),
    dot_character: { color: '#14b8a6', accessory: 'glasses' },
  },
  {
    name: 'visual',
    display_name: '비주얼',
    team: 'blog',
    role: 'visual',
    specialty: '이미지다이어그램큐레이터(삽입위치+설명문+대체텍스트,시각자료풍부화)',
    config: runtimeConfig('social'),
    dot_character: { color: '#ec4899', accessory: 'chart' },
  },
  {
    name: 'metrics',
    display_name: '메트릭스',
    team: 'blog',
    role: 'analyst',
    specialty: '성과분석가(7일후조회수/체류/공감수집,작가+편집조합추천,데이터기반최적화)',
    config: runtimeConfig('default'),
    dot_character: { color: '#f59e0b', accessory: 'chart' },
  },
  {
    name: 'social',
    display_name: '소셜',
    team: 'blog',
    role: 'social',
    specialty: '소셜미디어적응(블로그→인스타캡션+트위터요약+네이버카페,크로스플랫폼)',
    config: runtimeConfig('social'),
    dot_character: { color: '#3b82f6', accessory: 'compass' },
  },
];

async function main() {
  console.log(`🌱 블로팀 보강 시딩 (${BLOG_REINFORCEMENTS.length}건)...`);
  let ok = 0;
  let fail = 0;

  for (const agent of BLOG_REINFORCEMENTS) {
    try {
      const result = await registerAgent(agent);
      console.log(`  ✅ ${agent.name} (${agent.specialty.slice(0, 30)}...) → id=${result.id}`);
      ok += 1;
    } catch (error) {
      console.error(`  ❌ ${agent.name}: ${error.message}`);
      fail += 1;
    }
  }

  console.log(`\n🌱 완료: ${ok}건 성공, ${fail}건 실패`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
