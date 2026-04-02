#!/usr/bin/env node
'use strict';

const { registerAgent } = require('../../../packages/core/lib/agent-registry');

const NEW_AGENTS = [
  { name: 'darwin', display_name: '다윈', team: 'research', role: 'leader', specialty: '연구총괄+사이클오케스트레이션', llm_model: 'anthropic', dot_character: { color: '#6366f1', accessory: 'crown' } },
  { name: 'neuron', display_name: '뉴런', team: 'research', role: 'searcher', specialty: 'AI/멀티에이전트기술서칭(arXiv cs.AI)', llm_model: 'local/qwen2.5-7b', dot_character: { color: '#8b5cf6', accessory: 'magnifier' } },
  { name: 'gold-r', display_name: '골드', team: 'research', role: 'searcher', specialty: '투자/트레이딩전략서칭(arXiv q-fin)', llm_model: 'local/qwen2.5-7b', dot_character: { color: '#f59e0b', accessory: 'magnifier' } },
  { name: 'ink', display_name: '잉크', team: 'research', role: 'searcher', specialty: '콘텐츠/SEO/블로그서칭', llm_model: 'local/qwen2.5-7b', dot_character: { color: '#3b82f6', accessory: 'magnifier' } },
  { name: 'gavel', display_name: '가벨', team: 'research', role: 'searcher', specialty: '법률/SW감정서칭', llm_model: 'local/qwen2.5-7b', dot_character: { color: '#64748b', accessory: 'magnifier' } },
  { name: 'matrix-r', display_name: '매트릭스', team: 'research', role: 'searcher', specialty: '데이터사이언스/분석서칭', llm_model: 'local/qwen2.5-7b', dot_character: { color: '#06b6d4', accessory: 'magnifier' } },
  { name: 'frame', display_name: '프레임', team: 'research', role: 'searcher', specialty: '영상/편집기술서칭', llm_model: 'local/qwen2.5-7b', dot_character: { color: '#ec4899', accessory: 'magnifier' } },
  { name: 'gear', display_name: '기어', team: 'research', role: 'searcher', specialty: '시스템/인프라/보안서칭', llm_model: 'local/qwen2.5-7b', dot_character: { color: '#10b981', accessory: 'magnifier' } },
  { name: 'pulse', display_name: '펄스', team: 'research', role: 'searcher', specialty: '마케팅/수익화서칭', llm_model: 'local/qwen2.5-7b', dot_character: { color: '#ef4444', accessory: 'magnifier' } },
  { name: 'edison', display_name: '에디슨', team: 'research', role: 'builder', specialty: '프로토타입구현+실험코드', llm_model: 'anthropic', dot_character: { color: '#f97316', accessory: 'glasses' } },
  { name: 'proof-r', display_name: '프루프R', team: 'research', role: 'reviewer', specialty: '연구결과검증+재현성확인', llm_model: 'openai-oauth/gpt-5.4', dot_character: { color: '#ef4444', accessory: 'shield' } },
  { name: 'graft', display_name: '그래프트', team: 'research', role: 'deployer', specialty: '연구결과→에이전트적용', llm_model: 'openai-oauth/gpt-5.4', dot_character: { color: '#22c55e', accessory: 'compass' } },
  { name: 'medic', display_name: '메딕', team: 'research', role: 'diagnostician', specialty: '저성과에이전트진단+개선', llm_model: 'anthropic', dot_character: { color: '#059669', accessory: 'cross' } },
  { name: 'scholar', display_name: '스칼라', team: 'research', role: 'researcher', specialty: '심층연구+논문분석', llm_model: 'anthropic', dot_character: { color: '#4f46e5', accessory: 'book' } },
  { name: 'mentor', display_name: '멘토', team: 'research', role: 'trainer', specialty: '에이전트재교육+프롬프트튜닝', llm_model: 'anthropic', dot_character: { color: '#a855f7', accessory: 'book' } },

  { name: 'justin', display_name: '저스틴', team: 'legal', role: 'leader', specialty: '감정총괄+사건배정+최종검토', llm_model: 'anthropic', dot_character: { color: '#64748b', accessory: 'crown' } },
  { name: 'briefing', display_name: '브리핑', team: 'legal', role: 'analyst', specialty: '사건분석+감정요청분석', llm_model: 'openai-oauth/gpt-5.4', dot_character: { color: '#3b82f6', accessory: 'book' } },
  { name: 'lens', display_name: '렌즈', team: 'legal', role: 'analyst', specialty: '소스코드분석전문', llm_model: 'anthropic', dot_character: { color: '#6366f1', accessory: 'magnifier' } },
  { name: 'garam', display_name: '가람', team: 'legal', role: 'searcher', specialty: '국내판례서칭(대법원+하급심)', llm_model: 'local/qwen2.5-7b', dot_character: { color: '#14b8a6', accessory: 'magnifier' } },
  { name: 'atlas', display_name: '아틀라스', team: 'legal', role: 'searcher', specialty: '해외판례서칭(미국+EU)', llm_model: 'groq/llama-4-scout', dot_character: { color: '#0ea5e9', accessory: 'compass' } },
  { name: 'claim', display_name: '클레임', team: 'legal', role: 'analyst', specialty: '원고자료분석', llm_model: 'openai-oauth/gpt-5.4', dot_character: { color: '#f59e0b', accessory: 'chart' } },
  { name: 'defense', display_name: '디펜스', team: 'legal', role: 'analyst', specialty: '피고자료분석', llm_model: 'openai-oauth/gpt-5.4', dot_character: { color: '#ef4444', accessory: 'shield' } },
  { name: 'quill', display_name: '퀼', team: 'legal', role: 'writer', specialty: '감정서초안작성', llm_model: 'anthropic', dot_character: { color: '#8b5cf6', accessory: 'pen' } },
  { name: 'balance', display_name: '밸런스', team: 'legal', role: 'reviewer', specialty: '감정서품질검증+객관성심사', llm_model: 'anthropic', dot_character: { color: '#10b981', accessory: 'shield' } },
  { name: 'contro', display_name: '컨트로', team: 'legal', role: 'analyst', specialty: '계약서검토+소프트웨어계약분석', llm_model: 'openai-oauth/gpt-5.4', dot_character: { color: '#475569', accessory: 'glasses' } },

  { name: 'sigma', display_name: '시그마', team: 'data', role: 'leader', specialty: 'CDO+데이터전략수립', llm_model: 'anthropic', dot_character: { color: '#06b6d4', accessory: 'crown' } },
  { name: 'pipe', display_name: '파이프', team: 'data', role: 'engineer', specialty: '데이터파이프라인+ETL+품질관리', llm_model: 'local/qwen2.5-7b', dot_character: { color: '#22c55e', accessory: 'glasses' } },
  { name: 'pivot', display_name: '피벗', team: 'data', role: 'analyst', specialty: '데이터분석+통계+인사이트', llm_model: 'openai-oauth/gpt-5.4', dot_character: { color: '#3b82f6', accessory: 'chart' } },
  { name: 'oracle-ds', display_name: '오라클DS', team: 'data', role: 'ml_engineer', specialty: 'ML엔지니어+모델학습+추론최적화', llm_model: 'anthropic', dot_character: { color: '#8b5cf6', accessory: 'glasses' } },
  { name: 'canvas', display_name: '캔버스', team: 'data', role: 'visualizer', specialty: '데이터시각화+대시보드+리포트', llm_model: 'openai-oauth/gpt-5.4', dot_character: { color: '#f97316', accessory: 'chart' } },
  { name: 'curator', display_name: '큐레이터', team: 'data', role: 'governance', specialty: '데이터거버넌스+품질기준+카탈로그', llm_model: 'local/qwen2.5-7b', dot_character: { color: '#14b8a6', accessory: 'book' } },
];

async function main() {
  console.log(`🌱 3팀 신설 시딩 시작 (${NEW_AGENTS.length}건)...`);
  const teamCount = {};
  let ok = 0;
  let fail = 0;

  for (const agent of NEW_AGENTS) {
    try {
      const result = await registerAgent(agent);
      teamCount[agent.team] = (teamCount[agent.team] || 0) + 1;
      console.log(`  ✅ ${agent.name} (${agent.team}/${agent.specialty}) → id=${result.id}`);
      ok += 1;
    } catch (error) {
      console.error(`  ❌ ${agent.name}: ${error.message}`);
      fail += 1;
    }
  }

  console.log(`\n🌱 시딩 완료: ${ok}건 성공, ${fail}건 실패`);
  console.log(`  연구팀: ${teamCount.research || 0}, 감정팀: ${teamCount.legal || 0}, 데이터팀: ${teamCount.data || 0}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
