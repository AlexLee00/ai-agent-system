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

const MODEL_MAP = {
  simple:  'groq/llama-4-scout-17b-16e-instruct',
  medium:  'claude-haiku-4-5-20251001',
  complex: 'claude-sonnet-4-6',
  deep:    'claude-opus-4-6',
};

const COST_ESTIMATE = {
  simple:  0.000,
  medium:  0.006,
  complex: 0.018,
  deep:    0.090,
};

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
  worker: {
    document_classify:  'simple',
    ai_question:        'medium',
    report_generate:    'medium',
    revenue_forecast:   'complex',
  },
};

const TEAM_DEFAULTS = {
  ska:    'simple',
  claude: 'medium',
  luna:   'medium',
  worker: 'medium',
};

function classifyComplexity({ team, requestType, inputLength = 0, urgency = 'normal' }) {
  const teamMap = TEAM_REQUEST_MAP[team] || {};
  if (requestType && teamMap[requestType]) {
    let c = teamMap[requestType];
    if (urgency === 'critical' || urgency === 'high') {
      if (c === 'simple') c = 'medium';
    }
    return c;
  }

  let complexity = TEAM_DEFAULTS[team] || 'medium';
  if (inputLength > 3000) complexity = 'complex';
  else if (inputLength > 1000) complexity = 'medium';
  else if (inputLength < 200) complexity = 'simple';

  if ((urgency === 'critical' || urgency === 'high') && complexity === 'simple') {
    complexity = 'medium';
  }

  return complexity;
}

function selectModel({ team, requestType, inputLength = 0, urgency = 'normal' }) {
  const complexity = classifyComplexity({ team, requestType, inputLength, urgency });
  return {
    model:            MODEL_MAP[complexity],
    complexity,
    estimatedCostUsd: COST_ESTIMATE[complexity],
  };
}

module.exports = { selectModel, classifyComplexity, MODEL_MAP, COST_ESTIMATE, TEAM_REQUEST_MAP };
