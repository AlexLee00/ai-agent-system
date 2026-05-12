// @ts-nocheck
'use strict';

/**
 * topic-debate.ts — 4-Agent 토픽 토론 시스템
 *
 * arXiv 2601.08003 (LLM Blind Peer Review) 기반 N-Agent debate 구현
 * 4 에이전트가 독립적으로 토픽 평가 후 투표 + 신뢰도 집계
 *
 * 4 에이전트:
 *   ① Writer Agent    — 흥미롭고 쓰기 쉬운가?
 *   ② SEO Agent       — 검색 의도 매칭? 키워드 잠재력?
 *   ③ Marketer Agent  — 독자 전환 가능? 스터디카페 홍보 연계?
 *   ④ Critic Agent    — 차별성? 경쟁 포스팅 대비 우위?
 *
 * 결과:
 *   vote_score >= 70% → 즉시 진행
 *   vote_score 50~69% → 마스터 검토 플래그
 *   vote_score < 50%  → 다음 후보로
 */

let callLocalLlm;
try {
  callLocalLlm = require('../../../packages/core/lib/local-llm-client').callLocalLlm;
} catch {
  callLocalLlm = null;
}

const LLM_MODEL = 'qwen2.5:7b';
const LLM_TEMP  = 0.3;  // 토론이므로 약간 높게

async function askAgent(prompt, maxTokens = 150) {
  if (!callLocalLlm) return { content: '' };
  try {
    return await callLocalLlm({ prompt, model: LLM_MODEL, maxTokens, temperature: LLM_TEMP });
  } catch {
    return { content: '' };
  }
}

// ─────────────────────────── ① Writer Agent ─────────────────────────────────

async function evaluateAsWriter(topic, context = {}) {
  const recentTopics = (context.recentTopics || []).slice(0, 5).join(', ');
  const prompt = `블로그 작가 관점에서 이 토픽을 평가하라.

토픽: "${topic}"
최근 토픽들: ${recentTopics || '없음'}

다음을 JSON만 출력하라:
{
  "score": <0-100>,
  "vote": <"yes"|"no"|"maybe">,
  "reason": "(한 문장)",
  "writing_angle": "(이 토픽으로 쓸 수 있는 흥미로운 각도 1가지)"
}

평가 기준:
- 독창적 관점으로 쓸 수 있는가?
- 개인 경험/에피소드 연결 가능한가?
- 최근 토픽과 너무 유사하지 않은가?`;

  const res = await askAgent(prompt);
  return parseAgentResult(res, 'writer');
}

// ─────────────────────────── ② SEO Agent ────────────────────────────────────

async function evaluateAsSEO(topic, context = {}) {
  const category = String(context.category || '일반');
  const prompt = `네이버 SEO 전문가 관점에서 이 토픽을 평가하라.

토픽: "${topic}"
카테고리: ${category}

다음을 JSON만 출력하라:
{
  "score": <0-100>,
  "vote": <"yes"|"no"|"maybe">,
  "reason": "(한 문장)",
  "keyword_potential": "(핵심 검색 키워드 1~3개)",
  "intent_type": <"info"|"transaction"|"navigation">
}

평가 기준:
- 네이버 검색 수요 있는가? (트렌드/정보 검색)
- C-Rank 카테고리 일관성 기여하는가?
- 롱테일 키워드 기회 있는가?
- 검색 의도가 명확한가?`;

  const res = await askAgent(prompt);
  return parseAgentResult(res, 'seo');
}

// ─────────────────────────── ③ Marketer Agent ───────────────────────────────

async function evaluateAsMarketer(topic, context = {}) {
  const prompt = `마케터 관점에서 이 토픽을 평가하라. 목표: 스터디카페(커피랑도서관, 분당서현) 인지도 향상.

토픽: "${topic}"

다음을 JSON만 출력하라:
{
  "score": <0-100>,
  "vote": <"yes"|"no"|"maybe">,
  "reason": "(한 문장)",
  "cafe_connection": <"high"|"medium"|"low">,
  "target_audience": "(독자 타깃 1~2가지)"
}

평가 기준:
- 스터디카페 독자 타깃(IT 직장인, 학생, 카페 찾는 분당 주민)과 연관?
- 공유/바이럴 가능성?
- 독자가 "다음에 또 보고 싶은" 주제인가?`;

  const res = await askAgent(prompt);
  return parseAgentResult(res, 'marketer');
}

// ─────────────────────────── ④ Critic Agent ─────────────────────────────────

async function evaluateAsCritic(topic, context = {}) {
  const prompt = `비평가 관점에서 이 토픽을 평가하라. 냉정하게 평가하라.

토픽: "${topic}"

다음을 JSON만 출력하라:
{
  "score": <0-100>,
  "vote": <"yes"|"no"|"maybe">,
  "reason": "(한 문장)",
  "differentiation": <"high"|"medium"|"low">,
  "risks": ["(잠재적 위험 1~2가지)"]
}

평가 기준 (냉정하게):
- 이미 많은 블로그가 다루는 진부한 주제인가?
- 검색 결과에서 차별화될 수 있는가?
- 오해/논쟁 소지 있는 주제인가?
- 법적/윤리적 리스크?`;

  const res = await askAgent(prompt);
  return parseAgentResult(res, 'critic');
}

// ─────────────────────────── 결과 파싱 헬퍼 ─────────────────────────────────

function parseAgentResult(res, agentName) {
  const text = String(res?.content || '');
  let parsed = { score: 50, vote: 'maybe', reason: '' };
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) parsed = { ...parsed, ...JSON.parse(jsonMatch[0]) };
  } catch {
    // fallback
  }

  const score = Math.min(100, Math.max(0, Number(parsed.score) || 50));
  const vote  = ['yes', 'no', 'maybe'].includes(parsed.vote) ? parsed.vote : 'maybe';

  return {
    agent: agentName,
    score,
    vote,
    reason: String(parsed.reason || ''),
    ...(parsed.writing_angle  && { writing_angle: parsed.writing_angle }),
    ...(parsed.keyword_potential && { keyword_potential: parsed.keyword_potential }),
    ...(parsed.intent_type    && { intent_type: parsed.intent_type }),
    ...(parsed.cafe_connection && { cafe_connection: parsed.cafe_connection }),
    ...(parsed.target_audience && { target_audience: parsed.target_audience }),
    ...(parsed.differentiation && { differentiation: parsed.differentiation }),
    ...(parsed.risks          && { risks: parsed.risks }),
  };
}

// ─────────────────────────── 투표 집계 ──────────────────────────────────────

function aggregateVotes(agentResults) {
  if (!agentResults || agentResults.length === 0) {
    return { vote_score: 0, decision: 'skip', confidence: 0, avg_score: 0 };
  }

  // 가중치: Critic(1.5배) + SEO(1.3배) + Writer(1.0배) + Marketer(1.0배)
  const weights = { critic: 1.5, seo: 1.3, writer: 1.0, marketer: 1.0 };

  let totalWeight = 0;
  let yesWeight   = 0;
  let totalScore  = 0;

  for (const result of agentResults) {
    const w = weights[result.agent] || 1.0;
    totalWeight += w;
    totalScore  += result.score;

    if (result.vote === 'yes') yesWeight += w;
    else if (result.vote === 'maybe') yesWeight += w * 0.5;
    // 'no' → 0
  }

  const voteScore = totalWeight > 0 ? Math.round((yesWeight / totalWeight) * 100) : 0;
  const avgScore  = agentResults.length > 0 ? Math.round(totalScore / agentResults.length) : 0;

  let decision;
  if (voteScore >= 70) decision = 'proceed';
  else if (voteScore >= 50) decision = 'master_review';
  else decision = 'skip';

  // 비토 룰: critic이 'no' + score < 30 → 자동 skip
  const criticResult = agentResults.find((r) => r.agent === 'critic');
  if (criticResult && criticResult.vote === 'no' && criticResult.score < 30) {
    decision = 'skip';
  }

  return {
    vote_score: voteScore,
    avg_score: avgScore,
    decision,
    confidence: voteScore,
    veto_applied: criticResult?.vote === 'no' && criticResult?.score < 30,
  };
}

// ─────────────────────────── 메인: runTopicDebate ────────────────────────────

/**
 * 4-Agent 토픽 토론 실행
 *
 * @param {string} topic - 평가할 토픽
 * @param {object} context - { category, recentTopics }
 * @returns {object} - { topic, agents, vote, decision, summary }
 */
async function runTopicDebate(topic, context = {}) {
  if (!topic) return { topic: '', decision: 'skip', vote: { vote_score: 0 } };

  // 4 에이전트 병렬 실행
  const [writerRes, seoRes, marketerRes, criticRes] = await Promise.allSettled([
    evaluateAsWriter(topic, context),
    evaluateAsSEO(topic, context),
    evaluateAsMarketer(topic, context),
    evaluateAsCritic(topic, context),
  ]);

  const agentResults = [
    writerRes.status   === 'fulfilled' ? writerRes.value   : { agent: 'writer',   score: 50, vote: 'maybe', reason: '' },
    seoRes.status      === 'fulfilled' ? seoRes.value      : { agent: 'seo',      score: 50, vote: 'maybe', reason: '' },
    marketerRes.status === 'fulfilled' ? marketerRes.value : { agent: 'marketer', score: 50, vote: 'maybe', reason: '' },
    criticRes.status   === 'fulfilled' ? criticRes.value   : { agent: 'critic',   score: 50, vote: 'maybe', reason: '' },
  ];

  const vote = aggregateVotes(agentResults);

  const summary = [
    `토픽: "${topic}"`,
    `투표 결과: ${vote.vote_score}점 → ${vote.decision.toUpperCase()}`,
    agentResults.map((r) => `  [${r.agent}] ${r.vote}(${r.score}) — ${r.reason}`).join('\n'),
  ].join('\n');

  return {
    topic,
    agents: agentResults,
    vote,
    decision: vote.decision,
    summary,
    proceed: vote.decision === 'proceed',
    needs_master_review: vote.decision === 'master_review',
  };
}

/**
 * 여러 토픽 후보 중 최적 1개 선택
 * G-E-RG 패턴: 각 후보를 debate → 최고 점수 선택
 */
async function selectBestTopicByDebate(candidates, context = {}) {
  if (!candidates || candidates.length === 0) return null;

  const results = [];
  for (const topic of candidates.slice(0, 5)) {
    // 최대 5개만 평가 (비용 절감)
    const debateResult = await runTopicDebate(topic, context);
    results.push(debateResult);

    // 70점 이상이면 즉시 선택
    if (debateResult.vote.vote_score >= 70) {
      return { selected: topic, debate: debateResult, all_results: results };
    }
  }

  // 모두 70 미만이면 가장 높은 점수 선택
  const best = results.sort((a, b) => b.vote.vote_score - a.vote.vote_score)[0];
  return {
    selected: best.topic,
    debate: best,
    all_results: results,
    low_confidence: best.vote.vote_score < 50,
  };
}

module.exports = {
  runTopicDebate,
  selectBestTopicByDebate,
  evaluateAsWriter,
  evaluateAsSEO,
  evaluateAsMarketer,
  evaluateAsCritic,
  aggregateVotes,
};
