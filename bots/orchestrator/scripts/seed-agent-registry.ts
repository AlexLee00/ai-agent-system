// @ts-nocheck
'use strict';

const { registerAgent } = require('../../../packages/core/lib/agent-registry');

const AGENTS = [
  { name: 'blo', display_name: '블로', team: 'blog', role: 'leader', specialty: '블로그 팀장', llm_model: 'claude-code/sonnet', code_path: 'bots/blog/lib/blo.js' },
  { name: 'pos', display_name: '포스', team: 'blog', role: 'writer', specialty: 'IT기술작가', llm_model: 'claude-code/sonnet', code_path: 'bots/blog/lib/pos-writer.js', dot_character: { color: '#6366f1', accessory: 'glasses' } },
  { name: 'gems', display_name: '젬스', team: 'blog', role: 'writer', specialty: '감성에세이작가', llm_model: 'openai-oauth/gpt-5.4', code_path: 'bots/blog/lib/gems-writer.js', dot_character: { color: '#a855f7', accessory: 'pen' } },
  { name: 'richer', display_name: '리처', team: 'blog', role: 'researcher', specialty: '자료수집', llm_model: 'groq/llama-3.1-8b-instant', code_path: 'bots/blog/lib/richer.js' },
  { name: 'publ', display_name: '퍼블', team: 'blog', role: 'publisher', specialty: '발행관리', code_path: 'bots/blog/lib/publ.js', config: { llm_management: 'non-llm', non_llm_reason: 'publisher-executor' } },
  { name: 'maestro', display_name: '마에스트로', team: 'blog', role: 'orchestrator', specialty: '파이프라인', code_path: 'bots/blog/lib/maestro.js', config: { llm_management: 'non-llm', non_llm_reason: 'workflow-orchestrator' } },

  { name: 'luna', display_name: '루나', team: 'luna', role: 'leader', specialty: '펀드매니저', llm_model: 'groq/llama-4-scout', code_path: 'bots/investment/team/luna.js', dot_character: { color: '#f59e0b', accessory: 'crown' } },
  { name: 'aria', display_name: '아리아', team: 'luna', role: 'analyst', specialty: '기술분석', llm_model: 'openai-oauth/gpt-5.4', code_path: 'bots/investment/team/aria.js', dot_character: { color: '#ef4444', accessory: 'chart' } },
  { name: 'sentinel', display_name: '센티널', team: 'luna', role: 'analyst', specialty: '외부정보감시', llm_model: 'groq/llama-4-scout', code_path: 'bots/investment/team/sentinel.js' },
  { name: 'oracle', display_name: '오라클', team: 'luna', role: 'analyst', specialty: '기술분석', llm_model: 'groq/qwen/qwen3-32b', code_path: 'bots/investment/team/oracle.js' },
  { name: 'chronos', display_name: '크로노스', team: 'luna', role: 'analyst', specialty: '백테스팅', code_path: 'bots/investment/team/chronos.js', config: { llm_management: 'non-llm', non_llm_reason: 'deterministic-backtest' } },
  { name: 'scout', display_name: '스카우트', team: 'luna', role: 'analyst', specialty: '토스시장스캔/시장인텔리전스', llm_model: 'groq/llama-4-scout', code_path: 'bots/investment/team/scout.js', dot_character: { color: '#0ea5e9', accessory: 'radar' } },
  { name: 'nemesis', display_name: '네메시스', team: 'luna', role: 'risk', specialty: '리스크매니저', llm_model: 'groq/llama-4-scout', code_path: 'bots/investment/team/nemesis.js', dot_character: { color: '#64748b', accessory: 'shield' } },
  { name: 'zeus', display_name: '제우스', team: 'luna', role: 'executor', specialty: '주문실행', llm_model: 'groq/llama-4-scout', code_path: 'bots/investment/team/zeus.js' },
  { name: 'athena', display_name: '아테나', team: 'luna', role: 'executor', specialty: '주문실행', llm_model: 'groq/llama-4-scout', code_path: 'bots/investment/team/athena.js' },
  { name: 'sweeper', display_name: '스위퍼', team: 'luna', role: 'operator', specialty: '지갑정합성복구(dust추적,포지션-지갑대조,브로커청산반영)', code_path: 'bots/investment/team/sweeper.js', config: { llm_management: 'non-llm', non_llm_reason: 'wallet-reconciliation-deterministic-logic' }, dot_character: { color: '#14b8a6', accessory: 'broom' } },

  { name: 'dexter', display_name: '덱스터', team: 'claude', role: 'monitor', specialty: '시스템점검', code_path: 'bots/claude/src/dexter.js', is_always_on: true, dot_character: { color: '#10b981', accessory: 'magnifier' }, config: { llm_management: 'runtime-managed', runtime_team: 'claude', runtime_purpose: 'triage' } },
  { name: 'doctor', display_name: '닥터', team: 'claude', role: 'healer', specialty: '자동복구', code_path: 'bots/claude/lib/doctor.js', is_always_on: true, dot_character: { color: '#059669', accessory: 'cross' }, config: { llm_management: 'runtime-managed', runtime_team: 'claude', runtime_purpose: 'triage' } },
  { name: 'archer', display_name: '아처', team: 'claude', role: 'searcher', specialty: '기술수집', code_path: 'bots/claude/src/archer.js', is_always_on: true, config: { llm_management: 'runtime-managed', runtime_team: 'claude', runtime_purpose: 'reporting' } },
  { name: 'builder', display_name: '빌더', team: 'claude', role: 'builder', specialty: '코드빌드', code_path: 'bots/claude/src/builder.js', config: { llm_management: 'runtime-managed', runtime_team: 'claude', runtime_purpose: 'lead' } },
  { name: 'guardian', display_name: '가디언', team: 'claude', role: 'reviewer', specialty: '코드리뷰', code_path: 'bots/claude/src/guardian.js', config: { llm_management: 'runtime-managed', runtime_team: 'claude', runtime_purpose: 'lead' } },

  { name: 'andy', display_name: '앤디', team: 'ska', role: 'monitor', specialty: '예약감지', is_always_on: true, config: { llm_management: 'runtime-managed', runtime_team: 'ska', runtime_purpose: 'reporting' } },
  { name: 'jimmy', display_name: '지미', team: 'ska', role: 'operator', specialty: '예약처리', config: { llm_management: 'runtime-managed', runtime_team: 'ska', runtime_purpose: 'reporting' } },
  { name: 'rebecca', display_name: '레베카', team: 'ska', role: 'reporter', specialty: '리포트', config: { llm_management: 'runtime-managed', runtime_team: 'ska', runtime_purpose: 'reporting' } },
  { name: 'eve', display_name: '이브', team: 'ska', role: 'collector', specialty: '환경수집', is_always_on: true, config: { llm_management: 'runtime-managed', runtime_team: 'ska', runtime_purpose: 'reporting' } },

  { name: 'jay', display_name: '제이', team: 'jay', role: 'leader', specialty: '오케스트레이터', config: { llm_management: 'runtime-managed', runtime_team: 'orchestrator', runtime_purpose: 'fallback' } },
  { name: 'write', display_name: '라이트', team: 'jay', role: 'writer', specialty: '문서점검', is_always_on: true, config: { llm_management: 'runtime-managed', runtime_team: 'orchestrator', runtime_purpose: 'fallback' } },
  { name: 'steward', display_name: '스튜어드', team: 'jay', role: 'ops_assistant', specialty: '운영비서(TRACKER+코덱스+git+동기화+텔레그램+일일요약)', is_always_on: true, code_path: 'bots/orchestrator/src/steward.js', config: { llm_management: 'non-llm', non_llm_reason: 'ops-assistant-deterministic-logic' } },

  { name: 'worker', display_name: '워커', team: 'worker', role: 'leader', specialty: 'SaaS플랫폼', config: { llm_management: 'runtime-managed', runtime_team: 'worker', runtime_purpose: 'assistant' } },
  { name: 'video', display_name: '비디오', team: 'video', role: 'leader', specialty: '영상편집', config: { llm_management: 'runtime-managed', runtime_team: 'video', runtime_purpose: 'default' } },
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

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
