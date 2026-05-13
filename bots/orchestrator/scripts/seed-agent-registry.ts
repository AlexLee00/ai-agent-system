// @ts-nocheck
'use strict';

const { registerAgent } = require('../../../packages/core/lib/agent-registry');

function runtimeConfig(runtimeTeam, runtimePurpose = 'default', selectorKey = null) {
  return {
    llm_management: 'runtime-managed',
    runtime_team: runtimeTeam,
    runtime_purpose: runtimePurpose,
    llm_selector_key: selectorKey,
  };
}

function nonLlmConfig(reason) {
  return {
    llm_management: 'non-llm',
    non_llm_reason: reason,
    llm_selector_key: null,
  };
}

const AGENTS = [
  { name: 'blo', display_name: '블로', team: 'blog', role: 'leader', specialty: '블로그 팀장', code_path: 'bots/blog/lib/blo.js', config: runtimeConfig('blog', 'default', 'blog._default') },
  { name: 'pos', display_name: '포스', team: 'blog', role: 'writer', specialty: 'IT기술작가', code_path: 'bots/blog/lib/pos-writer.js', dot_character: { color: '#6366f1', accessory: 'glasses' }, config: runtimeConfig('blog', 'writer', 'blog.pos.writer') },
  { name: 'gems', display_name: '젬스', team: 'blog', role: 'writer', specialty: '감성에세이작가', code_path: 'bots/blog/lib/gems-writer.js', dot_character: { color: '#a855f7', accessory: 'pen' }, config: runtimeConfig('blog', 'writer', 'blog.gems.writer') },
  { name: 'richer', display_name: '리처', team: 'blog', role: 'researcher', specialty: '자료수집', code_path: 'bots/blog/lib/richer.js', config: runtimeConfig('blog', 'default', 'blog._default') },
  { name: 'publ', display_name: '퍼블', team: 'blog', role: 'publisher', specialty: '발행관리', code_path: 'bots/blog/lib/publ.js', config: nonLlmConfig('publisher-executor') },
  { name: 'maestro', display_name: '마에스트로', team: 'blog', role: 'orchestrator', specialty: '파이프라인', code_path: 'bots/blog/lib/maestro.js', config: nonLlmConfig('workflow-orchestrator') },

  { name: 'luna', display_name: '루나', team: 'luna', role: 'leader', specialty: '펀드매니저', code_path: 'bots/investment/team/luna.ts', dot_character: { color: '#f59e0b', accessory: 'crown' }, config: runtimeConfig('luna', 'commander', 'investment.luna') },
  { name: 'aria', display_name: '아리아', team: 'luna', role: 'analyst', specialty: '기술분석', code_path: 'bots/investment/team/aria.js', dot_character: { color: '#ef4444', accessory: 'chart' }, config: runtimeConfig('luna', 'analyst', 'investment.aria') },
  { name: 'sentinel', display_name: '센티널', team: 'luna', role: 'analyst', specialty: '외부정보감시', code_path: 'bots/investment/team/sentinel.js', config: runtimeConfig('luna', 'analyst', 'investment.sentinel') },
  { name: 'oracle', display_name: '오라클', team: 'luna', role: 'analyst', specialty: '기술분석', code_path: 'bots/investment/team/oracle.js', config: runtimeConfig('luna', 'analyst', 'investment.oracle') },
  { name: 'chronos', display_name: '크로노스', team: 'luna', role: 'analyst', specialty: '백테스팅', code_path: 'bots/investment/team/chronos.js', config: nonLlmConfig('deterministic-backtest') },
  { name: 'scout', display_name: '스카우트', team: 'luna', role: 'analyst', specialty: '토스시장스캔/시장인텔리전스', code_path: 'bots/investment/team/scout.js', dot_character: { color: '#0ea5e9', accessory: 'radar' }, config: runtimeConfig('luna', 'analyst', 'investment.scout') },
  { name: 'nemesis', display_name: '네메시스', team: 'luna', role: 'risk', specialty: '리스크매니저', code_path: 'bots/investment/team/nemesis.js', dot_character: { color: '#64748b', accessory: 'shield' }, config: runtimeConfig('luna', 'validator', 'investment.nemesis') },
  { name: 'zeus', display_name: '제우스', team: 'luna', role: 'executor', specialty: '주문실행', code_path: 'bots/investment/team/zeus.js', config: runtimeConfig('luna', 'validator', 'investment.zeus') },
  { name: 'athena', display_name: '아테나', team: 'luna', role: 'executor', specialty: '주문실행', code_path: 'bots/investment/team/athena.js', config: runtimeConfig('luna', 'validator', 'investment.athena') },
  { name: 'sweeper', display_name: '스위퍼', team: 'luna', role: 'operator', specialty: '지갑정합성복구(dust추적,포지션-지갑대조,브로커청산반영)', code_path: 'bots/investment/team/sweeper.js', config: nonLlmConfig('wallet-reconciliation-deterministic-logic'), dot_character: { color: '#14b8a6', accessory: 'broom' } },

  { name: 'dexter', display_name: '덱스터', team: 'claude', role: 'monitor', specialty: '시스템점검', code_path: 'bots/claude/src/dexter.js', is_always_on: true, dot_character: { color: '#10b981', accessory: 'magnifier' }, config: runtimeConfig('claude', 'triage', 'claude.dexter.ai_analyst') },
  { name: 'doctor', display_name: '닥터', team: 'claude', role: 'healer', specialty: '자동복구', code_path: 'bots/claude/lib/doctor.js', is_always_on: true, dot_character: { color: '#059669', accessory: 'cross' }, config: runtimeConfig('claude', 'triage', 'claude.lead.system_issue_triage') },
  { name: 'archer', display_name: '아처', team: 'claude', role: 'searcher', specialty: '기술수집', code_path: 'bots/claude/src/archer.js', is_always_on: true, config: runtimeConfig('claude', 'reporting', 'claude.archer.tech_analysis') },
  { name: 'builder', display_name: '빌더', team: 'claude', role: 'builder', specialty: '코드빌드', code_path: 'bots/claude/src/builder.js', config: runtimeConfig('claude', 'lead', 'claude.lead.system_issue_triage') },
  { name: 'guardian', display_name: '가디언', team: 'claude', role: 'reviewer', specialty: '코드리뷰', code_path: 'bots/claude/src/guardian.js', config: runtimeConfig('claude', 'lead', 'claude.lead.system_issue_triage') },

  { name: 'andy', display_name: '앤디', team: 'ska', role: 'monitor', specialty: '예약감지', is_always_on: true, config: runtimeConfig('ska', 'reporting', 'ska.classify') },
  { name: 'jimmy', display_name: '지미', team: 'ska', role: 'operator', specialty: '예약처리', config: runtimeConfig('ska', 'reporting', 'ska.classify') },
  { name: 'rebecca', display_name: '레베카', team: 'ska', role: 'reporter', specialty: '리포트', config: runtimeConfig('ska', 'reporting', 'ska._default') },
  { name: 'eve', display_name: '이브', team: 'ska', role: 'collector', specialty: '환경수집', is_always_on: true, config: runtimeConfig('ska', 'reporting', 'ska._default') },

  { name: 'jay', display_name: '제이', team: 'jay', role: 'leader', specialty: '오케스트레이터', config: runtimeConfig('orchestrator', 'fallback', 'orchestrator.jay.chat_fallback') },
  { name: 'write', display_name: '라이트', team: 'jay', role: 'writer', specialty: '문서점검', is_always_on: true, config: runtimeConfig('orchestrator', 'fallback', 'orchestrator.jay.chat_fallback') },
  { name: 'steward', display_name: '스튜어드', team: 'jay', role: 'ops_assistant', specialty: '운영비서(TRACKER+코덱스+git+동기화+텔레그램+일일요약)', is_always_on: true, code_path: 'bots/orchestrator/src/steward.js', config: nonLlmConfig('ops-assistant-deterministic-logic') },
];

async function main() {
  console.log(`🌱 Agent Registry 시딩 시작 (${AGENTS.length}건)...`);
  let ok = 0;
  let fail = 0;

  for (const agent of AGENTS) {
    try {
      const result = await registerAgent(agent);
      console.log(`  ✅ ${agent.name} (${agent.team}) → id=${result.id}`);
      ok += 1;
    } catch (error) {
      console.error(`  ❌ ${agent.name}: ${error.message}`);
      fail += 1;
    }
  }

  console.log(`\n🌱 시딩 완료: ${ok}건 성공, ${fail}건 실패`);
  process.exit(fail > 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  AGENTS,
  nonLlmConfig,
  runtimeConfig,
};
