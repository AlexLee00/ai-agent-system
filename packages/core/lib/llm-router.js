'use strict';

/**
 * packages/core/lib/llm-router.js — 복잡도 기반 LLM 모델 자동 라우팅
 *
 * 복잡도 분류:
 *   simple  → Groq llama-4-scout (무료)
 *   medium  → Claude Haiku (저비용)
 *   complex → Claude Sonnet (중비용)
 *   deep    → Claude Opus (고비용, 제한적)
 *
 * 사용법:
 *   const router = require('../../../packages/core/lib/llm-router');
 *   const { model, complexity } = router.selectModel({
 *     team: 'ska', requestType: 'exception_handling', inputLength: 300
 *   });
 */

// ── 복잡도 → 모델 매핑 ────────────────────────────────────────────────

const MODEL_MAP = {
  simple:  'groq/llama-4-scout-17b-16e-instruct',
  medium:  'claude-haiku-4-5-20251001',
  complex: 'claude-sonnet-4-6',
  deep:    'claude-opus-4-6',
};

// 예상 비용 (1K 토큰 입출력 기준, $)
const COST_ESTIMATE = {
  simple:  0.000,
  medium:  0.006,
  complex: 0.018,
  deep:    0.090,
};

// ── 팀별 요청 유형 → 복잡도 매핑 ─────────────────────────────────────

const TEAM_REQUEST_MAP = {
  ska: {
    status_check:        'simple',
    reservation_check:   'simple',
    pattern_match:       'simple',
    exception_handling:  'medium',
    conflict_resolution: 'medium',
    summary_report:      'medium',
    customer_analysis:   'complex',
  },
  claude: {
    status_check:         'simple',
    pattern_analysis:     'simple',
    alert_triage:         'medium',
    code_review:          'medium',
    improvement_analysis: 'complex',
    architecture_review:  'deep',
  },
  luna: {
    price_check:         'simple',
    technical_analysis:  'medium',
    signal_aggregation:  'medium',
    trade_decision:      'complex',
    risk_assessment:     'complex',
    strategy_review:     'deep',
  },
};

// 팀별 기본 복잡도
const TEAM_DEFAULTS = {
  ska:    'simple',
  claude: 'medium',
  luna:   'medium',
};

// ── 복잡도 분류 ────────────────────────────────────────────────────────

/**
 * 복잡도 분류
 * @param {object} opts
 * @param {string}  opts.team          'ska' | 'claude' | 'luna'
 * @param {string}  [opts.requestType] 요청 유형
 * @param {number}  [opts.inputLength] 입력 텍스트 길이
 * @param {string}  [opts.urgency]     'low' | 'normal' | 'high' | 'critical'
 * @returns {'simple'|'medium'|'complex'|'deep'}
 */
function classifyComplexity({ team, requestType, inputLength = 0, urgency = 'normal' }) {
  // 1. 팀 + 요청 유형 기반 (가장 우선)
  const teamMap = TEAM_REQUEST_MAP[team] || {};
  if (requestType && teamMap[requestType]) {
    let c = teamMap[requestType];
    // 긴급도 상향 (simple→medium, medium→complex / deep은 긴급도로 올리지 않음)
    if (urgency === 'critical' || urgency === 'high') {
      if (c === 'simple') c = 'medium';
    }
    return c;
  }

  // 2. 입력 길이 기반
  let complexity = TEAM_DEFAULTS[team] || 'medium';
  if (inputLength > 3000)      complexity = 'complex';
  else if (inputLength > 1000) complexity = 'medium';
  else if (inputLength < 200)  complexity = 'simple';

  // 긴급도 상향
  if ((urgency === 'critical' || urgency === 'high') && complexity === 'simple') {
    complexity = 'medium';
  }

  return complexity;
}

// ── 모델 선택 ──────────────────────────────────────────────────────────

/**
 * 복잡도에 맞는 모델 선택
 * @param {object} opts
 * @param {string}  opts.team
 * @param {string}  [opts.requestType]
 * @param {number}  [opts.inputLength]
 * @param {string}  [opts.urgency]
 * @returns {{ model: string, complexity: string, estimatedCostUsd: number }}
 */
function selectModel({ team, requestType, inputLength = 0, urgency = 'normal' }) {
  const complexity = classifyComplexity({ team, requestType, inputLength, urgency });
  return {
    model:            MODEL_MAP[complexity],
    complexity,
    estimatedCostUsd: COST_ESTIMATE[complexity],
  };
}

module.exports = { selectModel, classifyComplexity, MODEL_MAP, COST_ESTIMATE, TEAM_REQUEST_MAP };
