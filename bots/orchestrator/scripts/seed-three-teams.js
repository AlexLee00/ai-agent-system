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

  { name: 'echo', display_name: '에코', team: 'luna', role: 'analyst_short', specialty: '단기평균회귀분석(볼린저밴드역추세,승률70%목표)', llm_model: 'local/qwen2.5-7b', dot_character: { color: '#f43f5e', accessory: 'chart' } },
  { name: 'hera', display_name: '헤라', team: 'luna', role: 'analyst_long', specialty: '장기가치역발상분석(저평가매수,공포시진입)', llm_model: 'local/qwen2.5-7b', dot_character: { color: '#a78bfa', accessory: 'chart' } },
  { name: 'aegis', display_name: '이지스', team: 'luna', role: 'risk', specialty: '적응형유연리스크(ATR동적손절,VIX연동)', llm_model: 'groq/llama-4-scout', dot_character: { color: '#38bdf8', accessory: 'shield' } },
  { name: 'hound', display_name: '하운드', team: 'luna', role: 'watcher', specialty: '소셜커뮤니티감시(Reddit/X/텔레그램/웨일추적)', llm_model: 'local/qwen2.5-7b', dot_character: { color: '#fb923c', accessory: 'magnifier' } },
  { name: 'hermes', display_name: '헤르메스', team: 'luna', role: 'executor', specialty: '암호화폐스캘핑(수초~수분,차익거래)', llm_model: 'local/qwen2.5-7b', dot_character: { color: '#facc15', accessory: 'compass' } },
  { name: 'midas', display_name: '미다스', team: 'luna', role: 'executor', specialty: '주식배당장기보유(분기리밸런싱,현금흐름)', llm_model: 'local/qwen2.5-7b', dot_character: { color: '#fbbf24', accessory: 'crown' } },
  { name: 'funder', display_name: '펀더', team: 'luna', role: 'fundamental', specialty: '펀더멘탈분석(재무제표,어닝,PER/PBR,내부자거래)', llm_model: 'openai-oauth/gpt-5.4', dot_character: { color: '#059669', accessory: 'glasses' } },
  { name: 'vibe', display_name: '바이브', team: 'luna', role: 'sentiment', specialty: '시장감성분석(Fear&Greed,소셜온도,FOMO/FUD)', llm_model: 'local/qwen2.5-7b', dot_character: { color: '#e879f9', accessory: 'compass' } },
  { name: 'bullish', display_name: '불리쉬', team: 'luna', role: 'debater', specialty: '낙관론자(매수근거수집,상승시나리오,토론매수편)', llm_model: 'groq/llama-4-scout', dot_character: { color: '#22c55e', accessory: 'chart' } },
  { name: 'bearish', display_name: '베어리쉬', team: 'luna', role: 'debater', specialty: '비관론자(매도근거수집,하락시나리오,토론매도편)', llm_model: 'groq/llama-4-scout', dot_character: { color: '#ef4444', accessory: 'chart' } },
  { name: 'chaineye', display_name: '체인아이', team: 'luna', role: 'onchain', specialty: '온체인분석(MVRV,거래소잔고,웨일추적,스테이블코인)', llm_model: 'local/qwen2.5-7b', dot_character: { color: '#06b6d4', accessory: 'magnifier' } },
  { name: 'macro', display_name: '매크로', team: 'luna', role: 'macro', specialty: '매크로분석(Fed정책,DXY,글로벌M2,금리,채권)', llm_model: 'groq/llama-4-scout', dot_character: { color: '#8b5cf6', accessory: 'compass' } },
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
  console.log(`  연구팀: ${teamCount.research || 0}, 감정팀: ${teamCount.legal || 0}, 데이터팀: ${teamCount.data || 0}, 루나보강: ${teamCount.luna || 0}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
