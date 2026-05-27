// @ts-nocheck
/**
 * A2A Skill: Cross-Agent Validation
 *
 * 에이전트 간 교차 검증 — 한 에이전트의 분석을 다른 에이전트가 검증
 * 2026 트렌드: Multi-Agent Collaborative Verification
 *
 * 사용 사례:
 *   - oracle(분석) → sentinel(검증) → 합의 시 신호 확정
 *   - hermes(뉴스) → sophia(감성) 교차 검증
 *   - chronos(백테스트) → argos(진입) 적합성 검증
 */

import { query as defaultQuery } from '../../shared/db.ts';
import { registerSkillHandler } from '../handlers/task-handler.ts';

// ─── 검증 쌍 정의 ────────────────────────────────────────────

const VALIDATION_PAIRS = [
  { primary: 'oracle', validator: 'sentinel', domain: 'market_signal' },
  { primary: 'hermes', validator: 'sophia', domain: 'news_sentiment' },
  { primary: 'chronos', validator: 'argos', domain: 'backtest_entry' },
  { primary: 'hephaestos', validator: 'nemesis', domain: 'strategy_risk' },
  { primary: 'aria', validator: 'luna', domain: 'technical_fundamental' },
];

// ─── 교차 검증 실행 ─────────────────────────────────────────

async function runCrossAgentValidation(input, queryFn) {
  const primaryAgent = String(input?.primaryAgent || '').toLowerCase();
  const validatorAgent = String(input?.validatorAgent || '').toLowerCase();
  const signal = input?.signal || {};
  const symbol = String(input?.symbol || '').trim();
  const market = String(input?.market || 'crypto').trim();

  if (!primaryAgent || !validatorAgent || !symbol) {
    return { error: 'primaryAgent, validatorAgent, symbol 필수', validated: false };
  }

  // 1. 검증 쌍 확인
  const validPair = VALIDATION_PAIRS.find(
    p => p.primary === primaryAgent && p.validator === validatorAgent
  );

  // 2. 두 에이전트의 최근 정확도 조회
  const [primaryAccuracy, validatorAccuracy] = await Promise.all([
    fetchAgentAccuracy(queryFn, primaryAgent, market),
    fetchAgentAccuracy(queryFn, validatorAgent, market),
  ]);

  // 3. 교차 검증 점수 계산
  const primarySignalScore = extractSignalScore(signal.primaryResult);
  const validatorSignalScore = extractSignalScore(signal.validatorResult);

  const agreementScore = calcAgreement(primarySignalScore, validatorSignalScore);
  const combinedConfidence = calcCombinedConfidence(
    primaryAccuracy, validatorAccuracy, agreementScore
  );

  // 4. 검증 결과 판정
  const validated = agreementScore >= 0.6 && combinedConfidence >= 0.55;
  const conflictDetected = agreementScore < 0.4;

  // 5. 결과 기록
  const result = {
    symbol,
    market,
    primaryAgent,
    validatorAgent,
    domain: validPair?.domain || 'general',
    primaryAccuracy: Number(primaryAccuracy.toFixed(3)),
    validatorAccuracy: Number(validatorAccuracy.toFixed(3)),
    agreementScore: Number(agreementScore.toFixed(3)),
    combinedConfidence: Number(combinedConfidence.toFixed(3)),
    validated,
    conflictDetected,
    recommendation: buildRecommendation(validated, conflictDetected, agreementScore),
  };

  await recordValidationResult(queryFn, result);
  return result;
}

// ─── 검증 쌍 자동 탐지 ──────────────────────────────────────

async function autoSelectValidationPair(primaryAgent, queryFn, market) {
  const pair = VALIDATION_PAIRS.find(p => p.primary === primaryAgent);
  if (!pair) return null;
  return pair;
}

// ─── 에이전트 정확도 조회 ────────────────────────────────────

async function fetchAgentAccuracy(queryFn, agentName, market) {
  try {
    const colName = `${agentName}_accurate`;
    const rows = await queryFn(`
      SELECT
        COUNT(*) FILTER (WHERE ${colName} = true)::float /
        NULLIF(COUNT(*) FILTER (WHERE ${colName} IS NOT NULL), 0) AS accuracy
      FROM investment.trade_review
      WHERE market = $1
        AND created_at >= NOW() - INTERVAL '30 days'
    `, [market]);
    const accuracy = Number((Array.isArray(rows) ? rows[0] : rows?.rows?.[0])?.accuracy ?? 0.5);
    return Number.isFinite(accuracy) ? accuracy : 0.5;
  } catch (_err) {
    return 0.5;  // 데이터 없으면 중립
  }
}

// ─── 신호 점수 추출 ─────────────────────────────────────────

function extractSignalScore(result) {
  if (!result) return 0.5;

  // 다양한 신호 형식 지원
  if (typeof result.score === 'number') return Math.max(0, Math.min(1, result.score));
  if (result.action === 'buy') return result.confidence ?? 0.7;
  if (result.action === 'sell') return 1 - (result.confidence ?? 0.7);
  if (result.sentiment === 'positive') return 0.7;
  if (result.sentiment === 'negative') return 0.3;
  if (typeof result.confidence === 'number') return result.confidence;
  return 0.5;
}

// ─── 합의도 + 신뢰도 계산 ───────────────────────────────────

function calcAgreement(score1, score2) {
  // 두 점수의 방향 일치 여부 (0.5 기준)
  const dir1 = score1 > 0.5 ? 1 : score1 < 0.5 ? -1 : 0;
  const dir2 = score2 > 0.5 ? 1 : score2 < 0.5 ? -1 : 0;

  if (dir1 === 0 || dir2 === 0) return 0.5;  // 한쪽이 중립이면 중간
  if (dir1 === dir2) {
    // 방향 일치 — 크기 유사도 계산
    return 0.6 + Math.min(0.4, 1 - Math.abs(score1 - score2));
  }
  // 방향 불일치 — 충돌
  return Math.max(0, 0.5 - Math.abs(score1 - score2));
}

function calcCombinedConfidence(primaryAcc, validatorAcc, agreement) {
  return (primaryAcc * 0.4 + validatorAcc * 0.4 + agreement * 0.2);
}

// ─── 권장 사항 생성 ─────────────────────────────────────────

function buildRecommendation(validated, conflictDetected, agreement) {
  if (validated) {
    return `교차 검증 통과 (합의도 ${agreement.toFixed(2)}) — 신호 확정 권장`;
  }
  if (conflictDetected) {
    return `에이전트 충돌 감지 (합의도 ${agreement.toFixed(2)}) — 제3 에이전트 중재 또는 보류 권장`;
  }
  return `부분 합의 (합의도 ${agreement.toFixed(2)}) — 추가 확인 권장`;
}

// ─── 검증 결과 기록 ─────────────────────────────────────────

async function recordValidationResult(queryFn, result) {
  try {
    await queryFn(`
      INSERT INTO investment.agent_messages (
        incident_key, from_agent, to_agent, message_type, payload, created_at
      ) VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
    `, [
      `cross_validation_${result.symbol}_${Date.now()}`,
      result.primaryAgent,
      result.validatorAgent,
      'response',
      JSON.stringify(result),
    ]);
  } catch (_err) {
    // 로그 실패 무시
  }
}

// ─── 스킬 등록 ──────────────────────────────────────────────

export function register(options = {}) {
  const queryFn = options.query || defaultQuery;

  registerSkillHandler('cross-agent-validation', async (input) => {
    return runCrossAgentValidation(input, queryFn);
  });

  return { name: 'cross-agent-validation', registered: true };
}

export { runCrossAgentValidation, VALIDATION_PAIRS };
