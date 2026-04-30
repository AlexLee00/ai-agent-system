type Complexity = 'simple' | 'medium' | 'complex' | 'deep';

type SelectOptions = {
  team: string;
  requestType?: string;
  inputLength?: number;
  urgency?: 'low' | 'normal' | 'high' | 'critical';
};

type TeamRequestMap = Record<string, Record<string, Complexity>>;

const MODEL_MAP: Record<Complexity, string> = {
  simple: 'groq/llama-4-scout-17b-16e-instruct',
  medium: 'claude-haiku-4-5-20251001',
  complex: 'claude-sonnet-4-6',
  deep: 'claude-opus-4-6',
};

const COST_ESTIMATE: Record<Complexity, number> = {
  simple: 0,
  medium: 0.006,
  complex: 0.018,
  deep: 0.09,
};

const TEAM_REQUEST_MAP: TeamRequestMap = {
  ska: {
    status_check: 'simple',
    reservation_check: 'simple',
    pattern_match: 'simple',
    exception_handling: 'medium',
    conflict_resolution: 'medium',
    summary_report: 'medium',
    customer_analysis: 'complex',
  },
  claude: {
    status_check: 'simple',
    pattern_analysis: 'simple',
    alert_triage: 'medium',
    code_review: 'medium',
    improvement_analysis: 'complex',
    architecture_review: 'deep',
  },
  luna: {
    price_check: 'simple',
    technical_analysis: 'medium',
    signal_aggregation: 'medium',
    trade_decision: 'complex',
    risk_assessment: 'complex',
    strategy_review: 'deep',
  },
};

const TEAM_DEFAULTS: Record<string, Complexity> = {
  ska: 'simple',
  claude: 'medium',
  luna: 'medium',
  blog: 'medium',
  darwin: 'complex',
  sigma: 'medium',
  justin: 'complex',
};

function classifyComplexity({ team, requestType, inputLength = 0, urgency = 'normal' }: SelectOptions): Complexity {
  const teamMap = TEAM_REQUEST_MAP[team] || {};
  if (requestType && teamMap[requestType]) {
    let complexity = teamMap[requestType];
    if ((urgency === 'critical' || urgency === 'high') && complexity === 'simple') {
      complexity = 'medium';
    }
    return complexity;
  }

  let complexity: Complexity = TEAM_DEFAULTS[team] || 'medium';
  if (inputLength > 3000) complexity = 'complex';
  else if (inputLength > 1000) complexity = 'medium';
  else if (inputLength < 200) complexity = 'simple';

  if ((urgency === 'critical' || urgency === 'high') && complexity === 'simple') {
    complexity = 'medium';
  }

  return complexity;
}

function selectModel({ team, requestType, inputLength = 0, urgency = 'normal' }: SelectOptions): {
  model: string;
  complexity: Complexity;
  estimatedCostUsd: number;
} {
  const complexity = classifyComplexity({ team, requestType, inputLength, urgency });
  return {
    model: MODEL_MAP[complexity],
    complexity,
    estimatedCostUsd: COST_ESTIMATE[complexity],
  };
}

export = { selectModel, classifyComplexity, MODEL_MAP, COST_ESTIMATE, TEAM_REQUEST_MAP };
