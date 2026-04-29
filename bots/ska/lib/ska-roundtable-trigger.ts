// @ts-nocheck
'use strict';

/**
 * ska-roundtable-trigger.ts
 *
 * 스카팀 자기 복구 Layer 4: Roundtable 트리거
 *
 * 세 가지 조건 중 하나라도 충족 시 Jay + Claude + Ska Commander 3자 회의 진행:
 *   1. failure_cases.count ≥ 5 in 24h (반복 패턴)
 *   2. selector_history.deprecated > 3 in 7d (DOM 잦은 변경)
 *   3. auth_expired > 2 in 24h (인증 시스템 이상)
 *
 * 합의 결과 → ska-auto-dev-builder로 CODEX_SKA_EXCEPTION_*.md 생성
 *
 * Kill Switch: SKA_ROUNDTABLE_ENABLED=true (기본 false — 안전)
 * Daily Limit: SKA_ROUNDTABLE_DAILY_LIMIT=5
 *
 * 참조: AutoGen GroupChat, 알람 디스패치 허브 Roundtable 패턴
 */

const pgPool = require('../../../packages/core/lib/pg-pool');
const { callHubLlm } = require('../../../packages/core/lib/hub-client');
const { buildSkaIncidentDocument } = require('./ska-auto-dev-builder');

const SCHEMA = 'ska';
const DAILY_LIMIT = Number(process.env.SKA_ROUNDTABLE_DAILY_LIMIT || 5);
const DAILY_BUDGET_USD = Number(process.env.SKA_ROUNDTABLE_LLM_DAILY_BUDGET_USD || 3.0);
const COST_PER_ROUNDTABLE_USD = 0.05; // sonnet 3회 호출
const REPEAT_THRESHOLD = Number(process.env.SKA_ROUNDTABLE_REPEAT_THRESHOLD || 5);
const AUTH_EXPIRED_THRESHOLD = Number(process.env.SKA_ROUNDTABLE_AUTH_THRESHOLD || 2);
const SELECTOR_DEPRECATED_THRESHOLD = Number(process.env.SKA_ROUNDTABLE_SELECTOR_THRESHOLD || 3);

export interface RoundtableCondition {
  type: 'repeat_failure' | 'selector_churn' | 'auth_storm';
  agent: string;
  error_type: string;
  count: number;
  failure_case_id?: number;
  metadata?: Record<string, unknown>;
}

export interface RoundtableConsensus {
  roundtable_id: string;
  root_cause: string;
  proposed_fix: string;
  estimated_complexity: string;
  risk_level: string;
  success_criteria: string;
  auto_dev_path?: string;
}

/**
 * 현재 트리거 조건 확인
 */
export async function checkTriggerConditions(): Promise<RoundtableCondition[]> {
  const conditions: RoundtableCondition[] = [];

  // 조건 1: 24h 내 동일 패턴 5건+ (network_error 제외)
  const repeatRows = await pgPool.query(SCHEMA, `
    SELECT id, agent, error_type, count
    FROM ska.failure_cases
    WHERE last_seen >= NOW() - INTERVAL '24 hours'
      AND count >= $1
      AND error_type != 'network_error'
      AND auto_resolved = FALSE
    ORDER BY count DESC
    LIMIT 10
  `, [REPEAT_THRESHOLD]).catch(() => []);

  for (const row of repeatRows) {
    conditions.push({
      type: 'repeat_failure',
      agent: String(row.agent),
      error_type: String(row.error_type),
      count: Number(row.count),
      failure_case_id: Number(row.id),
    });
  }

  // 조건 2: 7일간 deprecated 셀렉터 3건+
  const selectorRow = await pgPool.get(SCHEMA, `
    SELECT COUNT(*)::int AS cnt
    FROM ska.selector_history
    WHERE deprecated_at >= NOW() - INTERVAL '7 days'
      AND status = 'deprecated'
  `, []).catch(() => ({ cnt: 0 }));

  if (Number(selectorRow?.cnt || 0) > SELECTOR_DEPRECATED_THRESHOLD) {
    conditions.push({
      type: 'selector_churn',
      agent: 'andy',
      error_type: 'selector_broken',
      count: Number(selectorRow?.cnt || 0),
      metadata: { deprecated_count: selectorRow?.cnt },
    });
  }

  // 조건 3: 24h 내 auth_expired 2건+
  const authRow = await pgPool.get(SCHEMA, `
    SELECT SUM(count)::int AS total
    FROM ska.failure_cases
    WHERE last_seen >= NOW() - INTERVAL '24 hours'
      AND error_type = 'auth_expired'
      AND auto_resolved = FALSE
  `, []).catch(() => ({ total: 0 }));

  if (Number(authRow?.total || 0) > AUTH_EXPIRED_THRESHOLD) {
    conditions.push({
      type: 'auth_storm',
      agent: 'multiple',
      error_type: 'auth_expired',
      count: Number(authRow?.total || 0),
    });
  }

  return conditions;
}

/**
 * 오늘 roundtable 횟수 확인 (daily limit 준수)
 */
async function getDailyCount(): Promise<number> {
  const row = await pgPool.get(SCHEMA, `
    SELECT COUNT(*)::int AS cnt
    FROM ska.failure_reflexions
    WHERE agent = 'roundtable'
      AND created_at >= CURRENT_DATE
  `, []).catch(() => ({ cnt: 0 }));
  return Number(row?.cnt || 0);
}

/**
 * 3자 회의: Jay (우선순위) + Claude (복잡도) + Ska Commander (근본 원인)
 * 각 관점을 순차적으로 LLM에서 생성 후 합의 도출
 */
async function runRoundtable(condition: RoundtableCondition): Promise<RoundtableConsensus | null> {
  const roundtableId = `ska-rt-${Date.now()}`;
  const contextSummary = buildContextSummary(condition);

  // Step 1: Jay 관점 — 운영 영향 + 우선순위
  const jayPerspective = await callHubLlm({
    callerTeam: 'ska',
    agent: 'ska-roundtable-jay',
    taskType: 'roundtable_priority',
    abstractModel: 'anthropic_sonnet',
    systemPrompt: `당신은 Jay(오케스트레이터)입니다. 스카팀 incident의 운영 영향을 평가하고 우선순위를 결정합니다.
짧고 명확하게 JSON으로만 답하세요.`,
    prompt: `${contextSummary}

운영 영향도와 우선순위를 평가하세요:
{"priority": "critical|high|medium|low", "operations_impact": "운영에 미치는 영향 1문장", "urgency": "즉시|당일|이번주"}`,
    maxTokens: 300,
    timeoutMs: 15_000,
  }).catch(() => null);

  // Step 2: Claude 관점 — 구현 복잡도
  const claudePerspective = await callHubLlm({
    callerTeam: 'ska',
    agent: 'ska-roundtable-claude',
    taskType: 'roundtable_complexity',
    abstractModel: 'anthropic_sonnet',
    systemPrompt: `당신은 Claude(구현 담당)입니다. 스카팀 incident의 기술적 복잡도와 구현 방안을 평가합니다.
짧고 명확하게 JSON으로만 답하세요.`,
    prompt: `${contextSummary}

구현 복잡도와 예상 수정 방안을 평가하세요:
{"complexity": "simple|medium|complex", "proposed_fix": "수정 방안 1~2문장", "estimated_effort": "1시간|반나절|하루|이틀+"}`,
    maxTokens: 400,
    timeoutMs: 15_000,
  }).catch(() => null);

  // Step 3: Ska Commander 관점 — 근본 원인 + 즉각 조치
  const commanderPerspective = await callHubLlm({
    callerTeam: 'ska',
    agent: 'ska-roundtable-commander',
    taskType: 'roundtable_root_cause',
    abstractModel: 'anthropic_sonnet',
    systemPrompt: `당신은 Ska Commander입니다. 스카팀 incident의 근본 원인과 즉각 조치를 결정합니다.
짧고 명확하게 JSON으로만 답하세요.`,
    prompt: `${contextSummary}

근본 원인과 즉각 조치를 분석하세요:
{"root_cause": "근본 원인 1문장", "immediate_action": "즉각 조치 방안", "risk_level": "high|medium|low", "success_criteria": "성공 기준 1문장"}`,
    maxTokens: 400,
    timeoutMs: 15_000,
  }).catch(() => null);

  const jay = parseJson(jayPerspective?.text || '{}') || {};
  const claude = parseJson(claudePerspective?.text || '{}') || {};
  const commander = parseJson(commanderPerspective?.text || '{}') || {};

  return {
    roundtable_id: roundtableId,
    root_cause: String(commander.root_cause || '미결정'),
    proposed_fix: String(claude.proposed_fix || commander.immediate_action || '검토 필요'),
    estimated_complexity: String(claude.complexity || 'medium'),
    risk_level: String(commander.risk_level || jay.priority || 'medium'),
    success_criteria: String(commander.success_criteria || '오류 재발 없음'),
  };
}

function buildContextSummary(condition: RoundtableCondition): string {
  return `## 스카팀 Incident 요약
- 트리거 유형: ${condition.type}
- 에이전트: ${condition.agent}
- 오류 유형: ${condition.error_type}
- 반복 횟수: ${condition.count}회
- failure_case_id: ${condition.failure_case_id || 'N/A'}
${condition.metadata ? `- 추가 정보: ${JSON.stringify(condition.metadata)}` : ''}`;
}

/**
 * 메인: 트리거 조건 확인 → 회의 실행 → auto-dev 문서 생성
 *
 * Kill Switch: SKA_ROUNDTABLE_ENABLED=true 일 때만 실행
 * 조건 체크 자체는 항상 실행 (주기적 폴링 가능)
 */
export async function checkAndTriggerRoundtable(): Promise<{
  triggered: boolean;
  conditions: RoundtableCondition[];
  consensus?: RoundtableConsensus;
  autoDevPath?: string;
}> {
  const conditions = await checkTriggerConditions();

  if (conditions.length === 0) {
    return { triggered: false, conditions: [] };
  }

  // Kill Switch 체크
  if (process.env.SKA_ROUNDTABLE_ENABLED !== 'true') {
    console.log(`[ska-roundtable] 조건 ${conditions.length}건 감지. SKA_ROUNDTABLE_ENABLED=true 로 활성화 필요.`);
    return { triggered: false, conditions };
  }

  // Daily limit 체크
  const dailyCount = await getDailyCount();
  if (dailyCount >= DAILY_LIMIT) {
    console.warn(`[ska-roundtable] 일일 한도 초과 (${dailyCount}/${DAILY_LIMIT}). 스킵.`);
    return { triggered: false, conditions };
  }

  // 예산 체크
  const usedUsd = dailyCount * COST_PER_ROUNDTABLE_USD;
  if (usedUsd >= DAILY_BUDGET_USD) {
    console.warn(`[ska-roundtable] 예산 초과 ($${usedUsd.toFixed(3)}/$${DAILY_BUDGET_USD}). 스킵.`);
    return { triggered: false, conditions };
  }

  // 가장 심각한 조건으로 회의 진행
  const primary = conditions[0];

  try {
    console.log(`[ska-roundtable] 회의 시작 type=${primary.type} agent=${primary.agent} count=${primary.count}`);
    const consensus = await runRoundtable(primary);

    if (!consensus) {
      console.warn(`[ska-roundtable] 합의 도출 실패`);
      return { triggered: true, conditions };
    }

    // Auto-dev 문서 생성 (Phase C)
    let autoDevPath: string | undefined;
    if (process.env.SKA_AUTO_DEV_DOC_ENABLED !== 'false') {
      const result = await buildSkaIncidentDocument({
        condition: primary,
        consensus,
      }).catch(() => null);
      autoDevPath = result?.path;
    }

    console.log(`[ska-roundtable] 완료 roundtable_id=${consensus.roundtable_id} auto_dev=${autoDevPath || 'skipped'}`);

    return { triggered: true, conditions, consensus, autoDevPath };
  } catch (err) {
    console.error(`[ska-roundtable] 오류:`, (err as Error).message);
    return { triggered: false, conditions };
  }
}

function parseJson(text: string): any {
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* fallthrough */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fallthrough */ } }
  return null;
}
