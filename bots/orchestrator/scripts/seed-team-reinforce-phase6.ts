// @ts-nocheck
'use strict';

const { registerAgent } = require('../../../packages/core/lib/agent-registry');

const NEW_AGENTS = [
  // Darwin team reinforce (7)
  { name: 'weaver', display_name: '위버', team: 'darwin', role: 'synthesizer', specialty: '다수서칭결과통합+연구맵작성', dot_character: { color: '#7c3aed', accessory: 'book' }, config: { llm_management: 'runtime-managed', runtime_team: 'darwin', runtime_purpose: 'synthesis' } },
  { name: 'ledger', display_name: '레저', team: 'darwin', role: 'source_auditor', specialty: '소스신뢰도평가+인용가능성검증', dot_character: { color: '#0f766e', accessory: 'shield' }, config: { llm_management: 'runtime-managed', runtime_team: 'darwin', runtime_purpose: 'review' } },
  { name: 'forge', display_name: '포지', team: 'darwin', role: 'replicator', specialty: '논문주장재현+실험재실행', dot_character: { color: '#ea580c', accessory: 'glasses' }, config: { llm_management: 'runtime-managed', runtime_team: 'darwin', runtime_purpose: 'research' } },
  { name: 'rift', display_name: '리프트', team: 'darwin', role: 'counterexample', specialty: '반례탐색+실패조건발굴', dot_character: { color: '#dc2626', accessory: 'magnifier' }, config: { llm_management: 'runtime-managed', runtime_team: 'darwin', runtime_purpose: 'review' } },
  { name: 'frontier', display_name: '프론티어', team: 'darwin', role: 'searcher', specialty: '최신성우선서칭(arXiv/GitHub/new repo)', dot_character: { color: '#2563eb', accessory: 'magnifier' }, config: { llm_management: 'runtime-managed', runtime_team: 'darwin', runtime_purpose: 'research' } },
  { name: 'canon', display_name: '캐논', team: 'darwin', role: 'searcher', specialty: '정통성우선서칭(survey/benchmark/official docs)', dot_character: { color: '#0891b2', accessory: 'book' }, config: { llm_management: 'runtime-managed', runtime_team: 'darwin', runtime_purpose: 'research' } },
  { name: 'skeptic-r', display_name: '스켑틱R', team: 'darwin', role: 'reviewer', specialty: '반례중심검토+재현성우선', dot_character: { color: '#b91c1c', accessory: 'shield' }, config: { llm_management: 'runtime-managed', runtime_team: 'darwin', runtime_purpose: 'review' } },

  // Justin team reinforce (8)
  { name: 'citecheck', display_name: '사이트체크', team: 'justin', role: 'citation_verifier', specialty: '판례/조문/인용진위검증', dot_character: { color: '#334155', accessory: 'shield' }, config: { llm_management: 'runtime-managed', runtime_team: 'justin', runtime_purpose: 'citation' } },
  { name: 'chain', display_name: '체인', team: 'justin', role: 'evidence_mapper', specialty: '주장-증거-반증맵구성', dot_character: { color: '#2563eb', accessory: 'compass' }, config: { llm_management: 'runtime-managed', runtime_team: 'justin', runtime_purpose: 'analysis' } },
  { name: 'bench', display_name: '벤치', team: 'justin', role: 'judge_simulator', specialty: '판사관점논리검토+비약지적', dot_character: { color: '#475569', accessory: 'glasses' }, config: { llm_management: 'runtime-managed', runtime_team: 'justin', runtime_purpose: 'opinion' } },
  { name: 'delta', display_name: '델타', team: 'justin', role: 'precedent_comparer', specialty: '유사판례차이점비교', dot_character: { color: '#0ea5e9', accessory: 'magnifier' }, config: { llm_management: 'runtime-managed', runtime_team: 'justin', runtime_purpose: 'analysis' } },
  { name: 'ledger-law', display_name: '레저로', team: 'justin', role: 'damages_analyst', specialty: '손해액/기여도/정량근거분석', dot_character: { color: '#f59e0b', accessory: 'chart' }, config: { llm_management: 'runtime-managed', runtime_team: 'justin', runtime_purpose: 'analysis' } },
  { name: 'plaintiff-x', display_name: '플레인티프X', team: 'justin', role: 'analyst', specialty: '원고친화편향분석+공격적구성', dot_character: { color: '#f97316', accessory: 'pen' }, config: { llm_management: 'runtime-managed', runtime_team: 'justin', runtime_purpose: 'analysis' } },
  { name: 'defense-x', display_name: '디펜스X', team: 'justin', role: 'analyst', specialty: '피고친화편향분석+보수적반박', dot_character: { color: '#ef4444', accessory: 'shield' }, config: { llm_management: 'runtime-managed', runtime_team: 'justin', runtime_purpose: 'analysis' } },
  { name: 'neutral-bench', display_name: '뉴트럴벤치', team: 'justin', role: 'reviewer', specialty: '중립심판관점균형검토', dot_character: { color: '#64748b', accessory: 'glasses' }, config: { llm_management: 'runtime-managed', runtime_team: 'justin', runtime_purpose: 'opinion' } },

  // Sigma team reinforce (8)
  { name: 'lab', display_name: '랩', team: 'sigma', role: 'experiment_designer', specialty: '가설설계+실험설계+검정전략', dot_character: { color: '#7c3aed', accessory: 'glasses' }, config: { llm_management: 'runtime-managed', runtime_team: 'sigma', runtime_purpose: 'experiment' } },
  { name: 'vector', display_name: '벡터', team: 'sigma', role: 'feature_engineer', specialty: '피처발굴+파생변수설계', dot_character: { color: '#0f766e', accessory: 'chart' }, config: { llm_management: 'runtime-managed', runtime_team: 'sigma', runtime_purpose: 'analysis' } },
  { name: 'sentry-d', display_name: '센트리D', team: 'sigma', role: 'qa_sentinel', specialty: '누락/이상치/드리프트감시', dot_character: { color: '#dc2626', accessory: 'shield' }, config: { llm_management: 'runtime-managed', runtime_team: 'sigma', runtime_purpose: 'quality' } },
  { name: 'cause', display_name: '코즈', team: 'sigma', role: 'causal_analyst', specialty: '상관/인과구분+혼입변수검토', dot_character: { color: '#2563eb', accessory: 'compass' }, config: { llm_management: 'runtime-managed', runtime_team: 'sigma', runtime_purpose: 'analysis' } },
  { name: 'scope', display_name: '스코프', team: 'sigma', role: 'observability', specialty: '지표/경보/대시보드관측설계', dot_character: { color: '#f97316', accessory: 'chart' }, config: { llm_management: 'runtime-managed', runtime_team: 'sigma', runtime_purpose: 'analysis' } },
  { name: 'explorer-d', display_name: '익스플로러D', team: 'sigma', role: 'analyst', specialty: '신규가설탐색+공격적피처실험', dot_character: { color: '#22c55e', accessory: 'magnifier' }, config: { llm_management: 'runtime-managed', runtime_team: 'sigma', runtime_purpose: 'analysis' } },
  { name: 'conservative-d', display_name: '컨서버티브D', team: 'sigma', role: 'reviewer', specialty: '재현성우선+안정성중심검토', dot_character: { color: '#64748b', accessory: 'shield' }, config: { llm_management: 'runtime-managed', runtime_team: 'sigma', runtime_purpose: 'quality' } },
  { name: 'skeptic-d', display_name: '스켑틱D', team: 'sigma', role: 'qa_sentinel', specialty: '데이터누수/샘플편향/과적합탐지', dot_character: { color: '#b91c1c', accessory: 'glasses' }, config: { llm_management: 'runtime-managed', runtime_team: 'sigma', runtime_purpose: 'quality' } },
];

async function main() {
  console.log(`🌱 Phase 6 팀 보강 시딩 시작 (${NEW_AGENTS.length}건)...`);
  const teamCount = {};
  let ok = 0;
  let fail = 0;

  for (const agent of NEW_AGENTS) {
    try {
      const result = await registerAgent(agent);
      teamCount[agent.team] = (teamCount[agent.team] || 0) + 1;
      console.log(`  ✅ ${agent.name} (${agent.team}/${agent.role}) → id=${result.id}`);
      ok += 1;
    } catch (error) {
      console.error(`  ❌ ${agent.name}: ${error.message}`);
      fail += 1;
    }
  }

  console.log(`\n🌱 시딩 완료: ${ok}건 성공, ${fail}건 실패`);
  console.log(`  다윈팀 보강: ${teamCount.darwin || 0}, 저스틴팀 보강: ${teamCount.justin || 0}, 시그마팀 보강: ${teamCount.sigma || 0}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
