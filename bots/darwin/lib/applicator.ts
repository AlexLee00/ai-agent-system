'use strict';

/**
 * 다윈팀 자율 적용 제안 파이프라인
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { callWithFallback } = require('../../../packages/core/lib/llm-fallback');
const { postAlarm } = require('../../../packages/core/lib/openclaw-client');
const eventLake = require('../../../packages/core/lib/event-lake');
const proposalStore = require('./proposal-store');

function buildDarwinFeedbackButtons(eventId) {
  if (!eventId) return [];
  return [[
    { text: '👍 유익함', callback_data: `darwin_feedback_up:${eventId}` },
    { text: '👎 아쉬움', callback_data: `darwin_feedback_down:${eventId}` },
  ]];
}

const TEAM_CONTEXT = `팀 제이 시스템 구조:
- 10팀 113에이전트, Node.js 모노레포
- 루나(자동매매 20에이전트): DAG 파이프라인, Bull/Bear 토론, ohlcv→분석→매매
- 블로(블로그 26에이전트): 작가 경쟁, maestro 오케스트레이션
- 클로드(모니터링 5에이전트): dexter 점검, doctor 자동복구
- 다윈(연구 22에이전트): arXiv 스캔, 논문 평가, 적용 제안
- 저스틴(감정 18에이전트): 소스코드 분석, 감정서 작성
- 시그마(데이터 13에이전트): ETL, ML, 시각화
- 스카(스터디카페 4), 워커(SaaS 2), 비디오(영상 1), 제이(오케스트레이터 2)
- LLM: groq + openai + claude-code 중심 폴백 체인, 로컬은 임베딩 전용
- DB: PostgreSQL + pgvector (RAG)
- 인프라: Mac Studio M4 Max (OPS) + MacBook Air M3 (DEV)`;

async function generateProposal(paper) {
  const result = await callWithFallback({
    chain: [
      { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', maxTokens: 800, temperature: 0.5 },
      { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 800, temperature: 0.5 },
    ],
    systemPrompt: `당신은 팀 제이의 기술 적용 전문가(graft)입니다.
${TEAM_CONTEXT}

논문의 핵심 아이디어를 우리 시스템에 적용하는 구체적 방안을 작성하세요.
반드시 아래 형식으로:

적용 대상 팀: (팀 이름)
적용 대상 에이전트: (에이전트 이름)
적용 방법: (구체적 3~5줄)
예상 효과: (1~2줄)
구현 난이도: (★~★★★★★)
필요 파일: (수정/생성할 파일 경로)`,
    userPrompt: `논문: ${paper.title}
요약: ${paper.korean_summary}
적합성: ${paper.relevance_score}점
이유: ${paper.reason}${paper.github ? `

## GitHub 소스 분석 (${paper.github.owner}/${paper.github.repo})
⭐ ${paper.github.stars} | 📝 ${paper.github.language} | 📂 ${paper.github.files}파일
${paper.github.summary}` : ''}`,
    logMeta: { team: 'darwin', bot: 'graft', requestType: 'proposal_generation' },
    timeoutMs: 12_000,
  });
  return result.text || '';
}

async function generatePrototype(paper, proposal) {
  const result = await callWithFallback({
    chain: [
      { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', maxTokens: 1200, temperature: 0.3 },
      { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 1200, temperature: 0.3 },
    ],
    systemPrompt: `당신은 팀 제이의 프로토타입 개발자(edison)입니다.
${TEAM_CONTEXT}

적용 방안을 기반으로 최소 동작하는 프로토타입 코드를 작성하세요.
Node.js (ES5, require) 스타일로 작성.
반드시 module.exports로 함수를 내보내세요.
실제 외부 API 호출은 하지 말고, 구조와 로직만 작성하세요.
주석으로 "여기서 실제 API 호출" 표시.`,
    userPrompt: `논문: ${paper.title}\n적용 방안:\n${proposal}`,
    logMeta: { team: 'darwin', bot: 'edison', requestType: 'prototype_generation' },
    timeoutMs: 15_000,
  });
  return result.text || '';
}

function verifyPrototype(code) {
  proposalStore.ensureDirs();
  const checks = { syntax: false, hasExports: false, noSideEffects: false, errors: [] };
  const tmpFile = path.join(proposalStore.SANDBOX_DIR, `proto_${Date.now()}.js`);

  try {
    fs.writeFileSync(tmpFile, code, 'utf8');
    execSync(`node --check "${tmpFile}"`, { stdio: 'pipe', timeout: 5000 });
    checks.syntax = true;
  } catch (err) {
    checks.errors.push(`문법 오류: ${err.stderr?.toString().slice(0, 200) || err.message}`);
  }

  checks.hasExports = /module\.exports/.test(code);
  if (!checks.hasExports) checks.errors.push('module.exports 누락');

  const dangerPatterns = [
    { pattern: /require\(['"]child_process['"]\)/, msg: 'child_process 사용 금지' },
    { pattern: /fs\.(unlink|rmdir|rm)Sync/, msg: '파일 삭제 금지' },
    { pattern: /process\.exit/, msg: 'process.exit 금지' },
    { pattern: /fetch\s*\(/, msg: '외부 API 호출 감지 (주석 필요)' },
  ];
  const hasDanger = dangerPatterns.some(({ pattern, msg }) => {
    if (pattern.test(code)) {
      checks.errors.push(msg);
      return true;
    }
    return false;
  });
  checks.noSideEffects = !hasDanger;

  try { fs.unlinkSync(tmpFile); } catch {}

  return {
    passed: checks.syntax && checks.hasExports && checks.noSideEffects,
    checks,
  };
}

async function apply(paper) {
  console.log(`[applicator] 시작: ${String(paper.title || '').slice(0, 60)}`);
  eventLake.record({
    eventType: 'proposal_generation_started',
    team: 'darwin',
    botName: 'applicator',
    severity: 'info',
    title: String(paper.title || '').slice(0, 140),
    message: '다윈 적용 제안 생성 시작',
    tags: ['proposal', 'generation', paper.domain || 'unknown'],
    metadata: {
      arxiv_id: paper.arxiv_id || '',
      relevance_score: Number(paper.relevance_score || 0),
    },
  }).catch(() => {});
  const proposalId = proposalStore.buildProposalId(paper);

  let proposal;
  try {
    proposal = await generateProposal(paper);
  } catch (err) {
    console.warn(`[applicator] graft 실패: ${err.message}`);
    return { proposal: null, prototype: null, verification: null, alarmSent: false, proposalId: null };
  }

  let prototype;
  try {
    prototype = await generatePrototype(paper, proposal);
  } catch (err) {
    console.warn(`[applicator] edison 실패: ${err.message}`);
    return { proposal, prototype: null, verification: null, alarmSent: false, proposalId: null };
  }

  const codeMatch = String(prototype || '').match(/```(?:javascript|js)?\n([\s\S]*?)```/);
  const codeOnly = codeMatch ? codeMatch[1].trim() : String(prototype || '').trim();
  const verification = verifyPrototype(codeOnly);
  const requiresApproval = autonomyLevel.requiresApproval();

  const statusIcon = verification.passed ? '✅' : '⚠️';
  const message = [
    `🔬 다윈팀 적용 제안 ${statusIcon}`,
    '',
    `📄 논문: ${String(paper.title || '').slice(0, 80)}`,
    paper.arxiv_id ? `🔗 https://arxiv.org/abs/${paper.arxiv_id}` : '',
    `📊 적합성: ${paper.relevance_score}점`,
    '',
    '📋 적용 방안:',
    String(proposal || '').slice(0, 600),
    '',
    `🔍 검증: ${verification.passed ? '통과' : `실패 — ${verification.checks.errors.join(', ')}`}`,
    '',
    verification.passed
      ? (requiresApproval ? '승인하려면 "적용 승인"이라고 답해주세요.' : 'L5 완전자율 모드 — 자동 구현을 이어서 진행합니다.')
      : '검증 실패 — 수동 검토 필요.',
  ].filter(Boolean).join('\n');

  const proposalData = {
    id: proposalId,
    arxiv_id: paper.arxiv_id,
    title: paper.title,
    paper,
    korean_summary: paper.korean_summary,
    relevance_score: paper.relevance_score,
    proposal,
    prototype: codeOnly,
    verification,
    status: verification.passed ? (requiresApproval ? 'pending_approval' : 'approved') : 'needs_review',
    created_at: new Date().toISOString(),
  };

  try {
    const savedPath = proposalStore.saveProposal(proposalData);
    console.log(`[applicator] 제안서 저장: ${savedPath}`);
  } catch (err) {
    console.warn(`[applicator] 제안서 저장 실패: ${err.message}`);
  }

  const proposalEventId = await eventLake.record({
    eventType: verification.passed ? 'proposal_generated' : 'proposal_review_required',
    team: 'darwin',
    botName: 'applicator',
    severity: verification.passed ? 'info' : 'warn',
    title: String(paper.title || '').slice(0, 140),
    message: verification.passed
      ? (requiresApproval ? '검증 통과 후 승인 대기' : '검증 통과 후 자동 구현 진행')
      : '프로토타입 검증 실패',
    tags: ['proposal', verification.passed ? 'passed' : 'failed'],
    metadata: {
      proposal_id: proposalId,
      arxiv_id: paper.arxiv_id || '',
      verification_passed: verification.passed,
      autonomy_level: requiresApproval ? 'L4' : 'L5',
    },
  }).catch(() => null);

  const primaryButtons = verification.passed && requiresApproval ? [[
    { text: '✅ 승인 — 구현 시작', callback_data: `darwin_approve:${proposalId}` },
    { text: '❌ 거절', callback_data: `darwin_reject:${proposalId}` },
  ]] : !verification.passed ? [[
    { text: '📝 수동 검토', callback_data: `darwin_manual:${proposalId}` },
    { text: '❌ 거절', callback_data: `darwin_reject:${proposalId}` },
  ]] : [];

  const alarmResult = await postAlarm({
    message: message.slice(0, 4000),
    team: 'darwin',
    alertLevel: 2,
    fromBot: 'applicator',
    inlineKeyboard: [...primaryButtons, ...buildDarwinFeedbackButtons(proposalEventId)],
  });
  if (proposalEventId) {
    eventLake.addFeedback(proposalEventId, {
      feedback: alarmResult?.ok === true ? 'alarm_sent' : 'alarm_failed',
    }).catch(() => {});
  }

  if (verification.passed && !requiresApproval) {
    const implementor = require('./implementor');
    setImmediate(() => {
      implementor.triggerImplementation(proposalId).catch((error) => {
        console.warn(`[applicator] 자동 구현 전환 실패: ${error.message}`);
      });
    });
  }

  return {
    proposal,
    prototype: codeOnly,
    verification,
    alarmSent: alarmResult?.ok === true,
    proposalId,
  };
}

module.exports = {
  apply,
  generateProposal,
  generatePrototype,
  verifyPrototype,
};
