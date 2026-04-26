// @ts-nocheck
'use strict';

const { registerAgent } = require('../../../packages/core/lib/agent-registry');

function runtimeConfig(purpose = 'analysis') {
  return { llm_management: 'runtime-managed', runtime_team: 'sigma', runtime_purpose: purpose };
}

const NEW_SIGMA_AGENTS = [
  {
    name: 'hawk',
    display_name: '호크',
    team: 'sigma',
    role: 'analyst',
    specialty: '비판적분석+리스크발견+실패패턴+병목탐지',
    config: runtimeConfig('analysis'),
    dot_character: { color: '#ef4444', accessory: 'magnifier' },
  },
  {
    name: 'dove',
    display_name: '도브',
    team: 'sigma',
    role: 'analyst',
    specialty: '낙관적분석+성공패턴확대+기회발견+강점강화',
    config: runtimeConfig('analysis'),
    dot_character: { color: '#22c55e', accessory: 'chart' },
  },
  {
    name: 'owl',
    display_name: '아울',
    team: 'sigma',
    role: 'analyst',
    specialty: '장기추세분석+주간월간트렌드+구조적변화감지',
    config: runtimeConfig('analysis'),
    dot_character: { color: '#8b5cf6', accessory: 'glasses' },
  },
  {
    name: 'optimizer',
    display_name: '옵티마이저',
    team: 'sigma',
    role: 'workflow',
    specialty: '워크플로우최적화+핸드오프분석+LLM비용분석+병목제거',
    config: runtimeConfig('quality'),
    dot_character: { color: '#f97316', accessory: 'compass' },
  },
  {
    name: 'librarian',
    display_name: '라이브러리안',
    team: 'sigma',
    role: 'rag',
    specialty: 'RAG대도서관관리+triplet축적+지식그래프+StandingOrders승격',
    config: runtimeConfig('analysis'),
    dot_character: { color: '#14b8a6', accessory: 'book' },
  },
  {
    name: 'forecaster',
    display_name: '포캐스터',
    team: 'sigma',
    role: 'predictor',
    specialty: '성과예측+매매예측+트래픽예측+리소스예측',
    config: runtimeConfig('analysis'),
    dot_character: { color: '#3b82f6', accessory: 'chart' },
  },
];

async function main() {
  console.log(`🌱 시그마 확장 시딩 시작 (${NEW_SIGMA_AGENTS.length}건)...`);
  let ok = 0;
  let fail = 0;

  for (const agent of NEW_SIGMA_AGENTS) {
    try {
      const result = await registerAgent(agent);
      console.log(`  ✅ ${agent.name} (${agent.team}/${agent.role}) -> id=${result.id}`);
      ok += 1;
    } catch (error) {
      console.error(`  ❌ ${agent.name}: ${error.message}`);
      fail += 1;
    }
  }

  console.log(`\n🌱 시딩 완료: ${ok}건 성공, ${fail}건 실패`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
