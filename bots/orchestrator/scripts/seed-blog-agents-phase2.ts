// @ts-nocheck
'use strict';

const { registerAgent } = require('../../../packages/core/lib/agent-registry');
const pgPool = require('../../../packages/core/lib/pg-pool');

function runtimeConfig(purpose = 'writer') {
  return { llm_management: 'runtime-managed', runtime_team: 'blog', runtime_purpose: purpose };
}

const NEW_BLOG_AGENTS = [
  {
    name: 'answer',
    display_name: '앤서',
    team: 'blog',
    role: 'writer',
    specialty: '분석리포트작가',
    config: runtimeConfig('writer'),
    dot_character: { color: '#3b82f6', accessory: 'chart' },
  },
  {
    name: 'tutor-blog',
    display_name: '튜터',
    team: 'blog',
    role: 'writer',
    specialty: '교육튜토리얼작가',
    config: runtimeConfig('curriculum'),
    dot_character: { color: '#8b5cf6', accessory: 'book' },
  },
  {
    name: 'curry',
    display_name: '커리',
    team: 'blog',
    role: 'planner',
    specialty: 'IT커리큘럼기획',
    config: runtimeConfig('curriculum'),
    dot_character: { color: '#f59e0b', accessory: 'compass' },
  },
  {
    name: 'trendy',
    display_name: '트렌디',
    team: 'blog',
    role: 'planner',
    specialty: '트렌드기획',
    config: runtimeConfig('default'),
    dot_character: { color: '#ec4899', accessory: 'compass' },
  },
  {
    name: 'mood',
    display_name: '무드',
    team: 'blog',
    role: 'planner',
    specialty: '감성주제기획',
    config: runtimeConfig('default'),
    dot_character: { color: '#d946ef', accessory: 'compass' },
  },
  {
    name: 'bookmark',
    display_name: '북마크',
    team: 'blog',
    role: 'researcher',
    specialty: '도서정보수집',
    config: runtimeConfig('default'),
    dot_character: { color: '#14b8a6', accessory: 'book' },
  },
  {
    name: 'mind',
    display_name: '마인드',
    team: 'blog',
    role: 'researcher',
    specialty: '심리학수집',
    config: runtimeConfig('default'),
    dot_character: { color: '#06b6d4', accessory: 'magnifier' },
  },
  {
    name: 'signal',
    display_name: '시그널',
    team: 'blog',
    role: 'researcher',
    specialty: 'SEO분석수집',
    config: runtimeConfig('default'),
    dot_character: { color: '#22c55e', accessory: 'chart' },
  },
  {
    name: 'styler',
    display_name: '스타일',
    team: 'blog',
    role: 'editor',
    specialty: '문체통일+SEO최적화편집',
    config: runtimeConfig('writer'),
    dot_character: { color: '#f97316', accessory: 'pen' },
  },
  {
    name: 'proof-blog',
    display_name: '프루프B',
    team: 'blog',
    role: 'reviewer',
    specialty: '품질검증+AI탐지체크',
    config: runtimeConfig('writer'),
    dot_character: { color: '#ef4444', accessory: 'shield' },
  },
];

const EXISTING_BLOG_AGENT_UPDATES = [
  { name: 'pos', specialty: 'IT기술작가(강의)', role: 'writer' },
  { name: 'gems', specialty: '감성에세이작가', role: 'writer' },
  { name: 'richer', specialty: 'IT뉴스수집', role: 'researcher' },
  { name: 'publ', specialty: '발행+성과수집', role: 'publisher' },
  { name: 'maestro', specialty: '파이프라인오케스트레이터', role: 'orchestrator' },
  { name: 'blo', specialty: '블로그팀장', role: 'leader' },
];

async function updateExistingAgents() {
  console.log(`🔄 기존 블로팀 에이전트 업데이트 (${EXISTING_BLOG_AGENT_UPDATES.length}건)...`);
  for (const update of EXISTING_BLOG_AGENT_UPDATES) {
    await pgPool.run(
      'agent',
      `UPDATE agent.registry
       SET specialty = $1, role = $2, updated_at = NOW()
       WHERE name = $3`,
      [update.specialty, update.role, update.name],
    );
    console.log(`  🔄 ${update.name} → ${update.specialty}`);
  }
}

async function seedNewAgents() {
  console.log(`🌱 블로팀 Phase 2 에이전트 시딩 (${NEW_BLOG_AGENTS.length}건)...`);
  let ok = 0;
  let fail = 0;

  for (const agent of NEW_BLOG_AGENTS) {
    try {
      const result = await registerAgent(agent);
      console.log(`  ✅ ${agent.name} (${agent.specialty}) → id=${result.id}`);
      ok += 1;
    } catch (error) {
      console.error(`  ❌ ${agent.name}: ${error.message}`);
      fail += 1;
    }
  }

  return { ok, fail };
}

async function main() {
  const { ok, fail } = await seedNewAgents();
  await updateExistingAgents();
  console.log(`\n🌱 시딩 완료: ${ok}건 성공, ${fail}건 실패`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
