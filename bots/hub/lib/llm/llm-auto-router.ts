'use strict';

// LLM Auto-Router — 프롬프트 복잡도를 분석해 abstractModel을 자동 선택
// Shadow Mode: LLM_AUTO_ROUTING_ENABLED=shadow → 분석만 하고 실제 모델은 overri하지 않음
// Active Mode: LLM_AUTO_ROUTING_ENABLED=true → abstractModel 없을 때 자동 주입

import path from 'node:path';
const PROJECT_ROOT = path.resolve(__dirname, '../../../..');
const pgPool = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool'));

// ─── 복잡도 → 모델 매핑 ──────────────────────────────────────────────────────

const COMPLEXITY_MODEL_MAP = {
  simple:  'anthropic_haiku',
  medium:  'anthropic_sonnet',
  complex: 'anthropic_opus',
  rag:     'anthropic_sonnet',  // RAG는 context가 길어도 sonnet 충분
} as const;

type Complexity = keyof typeof COMPLEXITY_MODEL_MAP;
type AbstractModel = typeof COMPLEXITY_MODEL_MAP[Complexity];

// ─── 복잡도 신호 가중치 ────────────────────────────────────────────────────────

const SIMPLE_SIGNALS = [
  /^what is\b/i, /^define\b/i, /^translate\b/i, /번역/,
  /^yes or no\b/i, /^true or false\b/i,
  /^summarize briefly\b/i, /^list \d/i,
];

const COMPLEX_SIGNALS = [
  /\banalyze\b/i, /\bdebug\b/i, /\brefactor\b/i, /\barchitecture\b/i,
  /\bmulti[-\s]step\b/i, /\breason through\b/i, /\bcompare and contrast\b/i,
  /\b분석\b/, /\b디버그\b/, /\b리팩토링\b/, /\b아키텍처\b/, /\b추론\b/,
  /\bcomprehensive\b/i, /\bin-depth\b/i, /\bexhaustive\b/i,
];

const RAG_SIGNALS = [
  /based on the following/i, /given the context/i, /from the document/i,
  /다음 문서를 참고/, /아래 내용을 바탕으로/, /컨텍스트를 참고/,
];

// ─── 타입 ────────────────────────────────────────────────────────────────────

export interface AutoRouterInput {
  prompt: string;
  systemPrompt?: string;
  abstractModel?: string;  // 이미 지정된 경우 Shadow 모드에선 비교만
  taskType?: string;
  agent?: string;
  callerTeam?: string;
  cacheEnabled?: boolean;
}

export interface AutoRouterResult {
  autoModel: AbstractModel;
  complexity: Complexity;
  complexityScore: number;
  routingSignals: Record<string, number | boolean | string>;
  modelOverridden: boolean;
  mode: 'shadow' | 'active' | 'disabled';
  // Active 모드에서 abstractModel이 없을 때만 주입된 최종 모델
  resolvedModel: string;
}

// ─── 복잡도 평가 ─────────────────────────────────────────────────────────────

function evaluateComplexity(input: AutoRouterInput): { complexity: Complexity; score: number; signals: Record<string, number | boolean | string> } {
  const prompt = input.prompt || '';
  const system = input.systemPrompt || '';
  const combined = `${system}\n${prompt}`;
  const promptChars = prompt.length;
  const contextChars = system.length;
  const taskType = (input.taskType || '').toLowerCase();

  const signals: Record<string, number | boolean | string> = {
    promptChars,
    contextChars,
    taskType: taskType || 'none',
  };

  let score = 0;

  // taskType 힌트 (가장 강력한 신호)
  if (['factual', 'lookup', 'classification'].includes(taskType)) {
    score -= 3;
    signals.taskTypeHint = 'simple';
  } else if (['generation', 'summary', 'translation'].includes(taskType)) {
    score += 2;
    signals.taskTypeHint = 'medium';
  } else if (['reasoning', 'analysis', 'debugging', 'planning', 'architecture'].includes(taskType)) {
    score += 5;
    signals.taskTypeHint = 'complex';
  }

  // 프롬프트 길이
  if (promptChars < 80) {
    score -= 2;
    signals.lengthBand = 'short';
  } else if (promptChars < 400) {
    score += 1;
    signals.lengthBand = 'medium';
  } else if (promptChars < 1500) {
    score += 3;
    signals.lengthBand = 'long';
  } else {
    score += 5;
    signals.lengthBand = 'very_long';
  }

  // 컨텍스트(system prompt) 길이 → RAG 가능성
  if (contextChars > 3000) {
    score += 2;
    signals.ragContext = true;
  }

  // 단순 신호
  const simpleMatch = SIMPLE_SIGNALS.some((r) => r.test(combined));
  if (simpleMatch) {
    score -= 4;
    signals.simpleSignal = true;
  }

  // 복잡 신호
  const complexCount = COMPLEX_SIGNALS.filter((r) => r.test(combined)).length;
  if (complexCount > 0) {
    score += complexCount * 2;
    signals.complexSignalCount = complexCount;
  }

  // RAG 신호
  const ragMatch = RAG_SIGNALS.some((r) => r.test(combined));
  if (ragMatch) {
    signals.ragSignal = true;
    // RAG면 context 길어도 sonnet으로 충분 → score를 중간 대역으로 고정
    if (score > 5) score = 5;
  }

  // 점수 → 복잡도 분류
  let complexity: Complexity;
  if (ragMatch && contextChars > 2000) {
    complexity = 'rag';
  } else if (score <= 0) {
    complexity = 'simple';
  } else if (score <= 4) {
    complexity = 'medium';
  } else {
    complexity = 'complex';
  }

  signals.finalScore = score;

  return { complexity, score, signals };
}

// ─── 메인 라우터 ─────────────────────────────────────────────────────────────

export function routeModel(input: AutoRouterInput): AutoRouterResult {
  const modeEnv = (process.env.LLM_AUTO_ROUTING_ENABLED || '').toLowerCase().trim();
  const mode: AutoRouterResult['mode'] =
    modeEnv === 'true' ? 'active'
    : modeEnv === 'shadow' ? 'shadow'
    : 'disabled';

  const { complexity, score, signals } = evaluateComplexity(input);
  const autoModel = COMPLEXITY_MODEL_MAP[complexity];
  const hasManualModel = Boolean(input.abstractModel);

  // Active 모드: manual 미지정 시 자동 주입, 지정 시 그대로 사용
  const modelOverridden = mode === 'active' && !hasManualModel;
  const resolvedModel = (mode === 'active' && !hasManualModel)
    ? autoModel
    : (input.abstractModel || autoModel);

  const result: AutoRouterResult = {
    autoModel,
    complexity,
    complexityScore: score,
    routingSignals: signals,
    modelOverridden,
    mode,
    resolvedModel,
  };

  // 비동기 로깅 (실패해도 무시)
  _logRouting(input, result).catch(() => {});

  return result;
}

// ─── DB 로깅 ─────────────────────────────────────────────────────────────────

async function _logRouting(input: AutoRouterInput, result: AutoRouterResult): Promise<void> {
  try {
    await pgPool.query('public', `
      INSERT INTO hub.llm_auto_routing_log
        (agent, caller_team, task_type, task_complexity, prompt_chars,
         context_chars, auto_model, manual_model, mode, model_overridden,
         complexity_score, routing_signals)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    `, [
      input.agent || null,
      input.callerTeam || null,
      input.taskType || null,
      result.complexity,
      (input.prompt || '').length,
      (input.systemPrompt || '').length,
      result.autoModel,
      input.abstractModel || null,
      result.mode,
      result.modelOverridden,
      result.complexityScore,
      JSON.stringify(result.routingSignals),
    ]);
  } catch {
    // 로깅 실패는 무시
  }
}

// ─── 결과 업데이트 (성공/실패 기록) ──────────────────────────────────────────

export async function updateRoutingResult(opts: {
  agent?: string;
  callerTeam?: string;
  autoModel: string;
  selectedProvider?: string;
  latencyMs?: number;
  costUsd?: number;
  success: boolean;
  qualityScore?: number;
  errorCode?: string;
}): Promise<void> {
  try {
    await pgPool.query('public', `
      UPDATE hub.llm_auto_routing_log
      SET selected_provider = $1,
          latency_ms        = $2,
          cost_usd          = $3,
          success           = $4,
          quality_score     = $5,
          error_code        = $6
      WHERE id = (
        SELECT id FROM hub.llm_auto_routing_log
        WHERE agent = $7
          AND auto_model = $8
          AND success IS NULL
        ORDER BY created_at DESC
        LIMIT 1
      )
    `, [
      opts.selectedProvider || null,
      opts.latencyMs || null,
      opts.costUsd || null,
      opts.success,
      opts.qualityScore || null,
      opts.errorCode || null,
      opts.agent || null,
      opts.autoModel,
    ]);
  } catch {
    // 무시
  }
}

// ─── 통계 조회 ────────────────────────────────────────────────────────────────

export async function getRoutingStats(hours = 24): Promise<Record<string, unknown>> {
  try {
    const rows = await pgPool.query('public', `
      SELECT
        task_complexity,
        auto_model,
        mode,
        COUNT(*)                         AS total,
        SUM(CASE WHEN success THEN 1 END) AS successes,
        AVG(latency_ms)::INT             AS avg_latency_ms,
        SUM(cost_usd)::NUMERIC(10,6)     AS total_cost_usd,
        AVG(quality_score)::NUMERIC(3,1) AS avg_quality
      FROM hub.llm_auto_routing_log
      WHERE created_at > NOW() - ($1 || ' hours')::INTERVAL
      GROUP BY task_complexity, auto_model, mode
      ORDER BY total DESC
    `, [String(hours)]);

    return {
      checkedAt: new Date().toISOString(),
      hours,
      rows,
    };
  } catch (e: any) {
    return { error: e?.message };
  }
}

module.exports = { routeModel, updateRoutingResult, getRoutingStats };
