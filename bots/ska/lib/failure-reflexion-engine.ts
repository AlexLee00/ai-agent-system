// @ts-nocheck
'use strict';

/**
 * failure-reflexion-engine.ts
 *
 * 스카팀 자기 복구 Layer 2: Reflexion + Chain-of-Hindsight
 *
 * 동일 패턴 3건+ 발생 시 (network_error 제외):
 *   1. 5-Why 분석 (왜 실패했나 → 근본 원인)
 *   2. Stage Attribution (어느 단계 책임)
 *   3. Hindsight ("X 대신 Y를 했어야 했다")
 *   4. avoid_pattern → ska.failure_reflexions 저장
 *   5. 다음 사이클에서 avoid_pattern retrieval → 사전 회피
 *
 * Kill Switch: SKA_REFLEXION_ENABLED=true (기본 false — 안전)
 * Budget Cap: SKA_REFLEXION_LLM_DAILY_BUDGET_USD=1.0
 * Threshold: SKA_REFLEXION_TRIGGER_THRESHOLD=3
 *
 * 참조: Reflexion (Shinn 2023), Luna reflexion-engine 패턴
 */

const pgPool = require('../../../packages/core/lib/pg-pool');
const { callHubLlm } = require('../../../packages/core/lib/hub-client');

const SCHEMA = 'ska';
const TRIGGER_THRESHOLD = Number(process.env.SKA_REFLEXION_TRIGGER_THRESHOLD || 3);
const DAILY_BUDGET_USD = Number(process.env.SKA_REFLEXION_LLM_DAILY_BUDGET_USD || 1.0);
// claude-haiku ~800 tokens ≈ $0.002 (input 600 + output 200)
const COST_PER_CALL_USD = 0.002;

// 네트워크 오류는 일시적이므로 reflexion 의미 없음 — 제외
const SKIP_ERROR_TYPES = new Set(['network_error']);

const AGENT_ROLES: Record<string, string> = {
  andy:      '네이버 예약 모니터링 (Puppeteer HTML 파싱)',
  jimmy:     '픽코 키오스크 모니터링 (DOM 파싱)',
  pickko:    '픽코 결제/주문 처리 (API 호출)',
  rebecca:   '매출 분석 리포트 (DB 집계)',
  eve:       '환경 요인 크롤링 (날씨/이벤트)',
  commander: '스카팀 전체 명령 처리 (오케스트레이터)',
};

interface FailureCaseInput {
  id: number;
  agent: string;
  error_type: string;
  error_message: string;
  count: number;
}

interface SkaReflexionResult {
  failure_case_id: number;
  agent: string;
  error_type: string;
  five_why: Array<{ q: string; a: string }>;
  stage_attribution: Record<string, number>;
  hindsight: string;
  avoid_pattern: {
    agent_pattern: string;
    error_type: string;
    avoid_action: string;
    reason: string;
    evidence_ids: number[];
  };
  llm_provider: string;
}

async function shouldRunReflexion(
  failureCaseId: number,
  errorType: string,
  count: number,
): Promise<boolean> {
  if (SKIP_ERROR_TYPES.has(errorType)) return false;
  if (count < TRIGGER_THRESHOLD) return false;

  const existing = await pgPool.get(SCHEMA, `
    SELECT id FROM ska.failure_reflexions
    WHERE failure_case_id = $1
    LIMIT 1
  `, [failureCaseId]).catch(() => null);

  return !existing;
}

async function ensureDailyBudget(): Promise<{ ok: boolean; usedUsd: number }> {
  if (DAILY_BUDGET_USD <= 0) return { ok: true, usedUsd: 0 };

  const row = await pgPool.get(SCHEMA, `
    SELECT COUNT(*)::int AS cnt
    FROM ska.failure_reflexions
    WHERE created_at >= CURRENT_DATE
  `, []).catch(() => ({ cnt: 0 }));

  const cnt = Number(row?.cnt || 0);
  const usedUsd = cnt * COST_PER_CALL_USD;
  return { ok: usedUsd <= DAILY_BUDGET_USD, usedUsd };
}

async function runLlmReflexion(fc: FailureCaseInput): Promise<SkaReflexionResult | null> {
  const agentRole = AGENT_ROLES[fc.agent] || fc.agent;
  const safeMessage = String(fc.error_message || '').slice(0, 400);

  const systemPrompt = `당신은 자동화 봇 장애 분석 전문가입니다.
스카팀(스터디카페 예약/관리 자동화 시스템)의 에이전트 반복 오류를 분석합니다.
반드시 유효한 JSON 형식으로만 답하세요. 설명이나 마크다운 없이 JSON만 출력하세요.`;

  const userPrompt = `## 반복 장애 분석 요청
에이전트: ${fc.agent} (${agentRole})
오류 유형: ${fc.error_type}
오류 메시지: ${safeMessage}
반복 횟수: ${fc.count}회 (${TRIGGER_THRESHOLD}회+ 반복 패턴)

다음 3가지를 JSON으로 생성하세요:
1. five_why: 5단계 원인 분석 Q&A 배열
2. hindsight: "이 상황에서는 X 대신 Y를 했어야 했다" 형식의 1~2문장
3. avoid_pattern: 향후 회피할 패턴 정보

{
  "five_why": [
    {"q": "왜 실패했나?", "a": "..."},
    {"q": "왜 ...?", "a": "..."},
    {"q": "왜 ...?", "a": "..."},
    {"q": "왜 ...?", "a": "..."},
    {"q": "왜 ...?", "a": "..."}
  ],
  "hindsight": "이 상황에서는 X 대신 Y를 했어야 했다.",
  "avoid_pattern": {
    "agent_pattern": "${fc.agent}/${fc.error_type}",
    "error_type": "${fc.error_type}",
    "avoid_action": "구체적인 회피할 행동 (예: selector_cache_without_fallback)",
    "reason": "회피 이유 한국어 1문장"
  }
}`;

  try {
    const response = await callHubLlm({
      callerTeam: 'ska',
      agent: 'ska-reflexion-engine',
      taskType: 'reflexion',
      abstractModel: 'anthropic_haiku',
      prompt: userPrompt,
      systemPrompt,
      maxTokens: 900,
      timeoutMs: 25_000,
      maxBudgetUsd: 0.01,
    });

    if (!response.ok || !response.text) {
      console.warn(`[ska-reflexion] LLM 응답 없음 failure_case_id=${fc.id}`);
      return null;
    }

    const parsed = parseJson(response.text);
    if (!parsed) {
      console.warn(`[ska-reflexion] JSON 파싱 실패 failure_case_id=${fc.id}`);
      return null;
    }

    return {
      failure_case_id: fc.id,
      agent: fc.agent,
      error_type: fc.error_type,
      five_why: Array.isArray(parsed.five_why) ? parsed.five_why : [],
      stage_attribution: { [fc.error_type]: 1.0 },
      hindsight: String(parsed.hindsight || ''),
      avoid_pattern: {
        agent_pattern: `${fc.agent}/${fc.error_type}`,
        error_type: fc.error_type,
        avoid_action: String(parsed.avoid_pattern?.avoid_action || ''),
        reason: String(parsed.avoid_pattern?.reason || ''),
        evidence_ids: [fc.id],
        ...(parsed.avoid_pattern || {}),
      },
      llm_provider: response.provider || response.model || 'unknown',
    };
  } catch (err) {
    console.error(`[ska-reflexion] LLM 오류 failure_case_id=${fc.id}:`, (err as Error).message);
    return null;
  }
}

async function persistReflexion(result: SkaReflexionResult): Promise<void> {
  await pgPool.run(SCHEMA, `
    INSERT INTO ska.failure_reflexions
      (failure_case_id, agent, error_type, five_why, stage_attribution,
       hindsight, avoid_pattern, llm_provider)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (failure_case_id) DO UPDATE SET
      five_why          = EXCLUDED.five_why,
      stage_attribution = EXCLUDED.stage_attribution,
      hindsight         = EXCLUDED.hindsight,
      avoid_pattern     = EXCLUDED.avoid_pattern,
      llm_provider      = EXCLUDED.llm_provider,
      created_at        = NOW()
  `, [
    result.failure_case_id,
    result.agent,
    result.error_type,
    JSON.stringify(result.five_why),
    JSON.stringify(result.stage_attribution),
    result.hindsight,
    JSON.stringify(result.avoid_pattern),
    result.llm_provider,
  ]);
}

/**
 * 메인: failure_case에 대해 Reflexion 실행 (비동기, 모니터 무영향)
 *
 * Kill Switch: SKA_REFLEXION_ENABLED=true 일 때만 실행
 * ska-failure-reporter.ts의 reportFailure에서 RETURNING 후 호출
 */
export async function maybeRunReflexion(opts: {
  failureCaseId: number;
  agent: string;
  errorType: string;
  count: number;
  errorMessage: string;
}): Promise<void> {
  if (process.env.SKA_REFLEXION_ENABLED !== 'true') return;

  try {
    const should = await shouldRunReflexion(opts.failureCaseId, opts.errorType, opts.count);
    if (!should) return;

    const budget = await ensureDailyBudget();
    if (!budget.ok) {
      console.warn(`[ska-reflexion] 일일 예산 초과 (${DAILY_BUDGET_USD}USD, 사용: ${budget.usedUsd.toFixed(3)}USD). 스킵.`);
      return;
    }

    const result = await runLlmReflexion({
      id: opts.failureCaseId,
      agent: opts.agent,
      error_type: opts.errorType,
      error_message: opts.errorMessage,
      count: opts.count,
    });

    if (result) {
      await persistReflexion(result);
      console.log(`[ska-reflexion] 완료 failure_case_id=${opts.failureCaseId} agent=${opts.agent} type=${opts.errorType}`);
    }
  } catch (_err) {
    // reflexion 실패는 조용히 무시 — 모니터 동작 절대 중단 금지
  }
}

/**
 * 특정 에이전트의 avoid_pattern 조회 (다음 사이클 사전 회피용)
 */
export async function getAvoidPatterns(
  agent: string,
  errorType?: string,
  limit = 10,
): Promise<any[]> {
  const params: any[] = [agent];
  let sql = `
    SELECT id, agent, error_type, avoid_pattern, hindsight, created_at
    FROM ska.failure_reflexions
    WHERE agent = $1
      AND avoid_pattern IS NOT NULL
  `;
  if (errorType) {
    params.push(errorType);
    sql += ` AND error_type = $${params.length}`;
  }
  sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);

  return pgPool.query(SCHEMA, sql, params).catch(() => []);
}

/**
 * 전체 avoid_pattern 목록 (weekly review / roundtable용)
 */
export async function getAllAvoidPatterns(limit = 50): Promise<any[]> {
  return pgPool.query(SCHEMA, `
    SELECT id, agent, error_type, avoid_pattern, hindsight, created_at
    FROM ska.failure_reflexions
    WHERE avoid_pattern IS NOT NULL
    ORDER BY created_at DESC
    LIMIT $1
  `, [limit]).catch(() => []);
}

/**
 * 오늘 reflexion 통계 (비용 모니터링용)
 */
export async function getDailyReflexionStats(): Promise<{ count: number; estimatedUsd: number }> {
  const row = await pgPool.get(SCHEMA, `
    SELECT COUNT(*)::int AS cnt
    FROM ska.failure_reflexions
    WHERE created_at >= CURRENT_DATE
  `, []).catch(() => ({ cnt: 0 }));

  const count = Number(row?.cnt || 0);
  return { count, estimatedUsd: count * COST_PER_CALL_USD };
}

function parseJson(text: string): any {
  try { return JSON.parse(text); } catch { /* fallthrough */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fallthrough */ } }
  return null;
}
