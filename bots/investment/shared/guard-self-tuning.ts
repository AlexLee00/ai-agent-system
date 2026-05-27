// @ts-nocheck
/**
 * shared/guard-self-tuning.ts — 가드 자율 조정 메커니즘 (Phase 4)
 *
 * 마스터 비전: "가드 임계값을 자율 학습!"
 *
 * 흐름:
 *   1. measureGuardEffectiveness(guardName, days) — 가드 정확도 측정
 *   2. suggestThresholdAdjustment(guardName)      — LLM 분석 → 임계값 추천
 *   3. applyThresholdAdjustment(guardName, value) — Shadow 1주 검증 후 적용
 *
 * 자율 조정 기준:
 *   - false positive 비율 > 30% → 임계값 완화 (가드 덜 민감하게)
 *   - false positive 비율 < 5%  → 임계값 강화 (가드 더 민감하게)
 *   - Shadow Mode 1주 검증 필수
 *   - 마스터 승인 후 live 적용
 */

import { query, run } from './db/core.ts';
import { callLLM } from './llm-client.ts';
import { getPosttradeFeedbackRuntimeConfig } from './runtime-config.ts';

const SELF_TUNING_TABLE = 'investment.guard_self_tuning_log';

async function ensureSelfTuningTable() {
  await run(`
    CREATE TABLE IF NOT EXISTS ${SELF_TUNING_TABLE} (
      id              BIGSERIAL PRIMARY KEY,
      guard_name      TEXT NOT NULL,
      analysis_date   DATE NOT NULL DEFAULT CURRENT_DATE,
      days_analyzed   INTEGER NOT NULL,
      total_triggers  INTEGER,
      false_positive_rate NUMERIC(5,4),
      current_threshold   JSONB,
      suggested_threshold JSONB,
      llm_reasoning       TEXT,
      shadow_mode         BOOLEAN DEFAULT TRUE,
      shadow_start_at     TIMESTAMPTZ,
      shadow_end_at       TIMESTAMPTZ,
      master_approved     BOOLEAN DEFAULT FALSE,
      applied_at          TIMESTAMPTZ,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => null);
}

/**
 * 가드 효과 측정: 트리거 후 실제 거래 결과를 비교하여 false positive 비율 계산.
 * false positive = 가드가 트리거됐으나 결과가 success (가드가 불필요했음)
 */
export async function measureGuardEffectiveness(guardName, days = 30) {
  const rows = await query(
    `SELECT
       COUNT(*)                                           AS total_triggers,
       COUNT(*) FILTER (WHERE outcome IS NOT NULL)       AS outcome_known,
       COUNT(*) FILTER (WHERE outcome = 'success')       AS false_positive_count,
       COUNT(*) FILTER (WHERE outcome = 'failure')       AS true_positive_count,
       AVG(outcome_pnl_usd) FILTER (
         WHERE outcome_pnl_usd IS NOT NULL
       )                                                 AS avg_pnl_usd,
       SUM(ABS(outcome_pnl_usd)) FILTER (
         WHERE outcome_pnl_usd IS NOT NULL
       )                                                 AS total_abs_pnl_usd
     FROM investment.guard_events
    WHERE guard_name = $1
      AND triggered_at >= NOW() - $2::interval`,
    [guardName, `${days} days`],
  ).catch(() => []);

  const row = rows?.[0] || {};
  const total = Number(row.total_triggers || 0);
  const outcomeKnown = Number(row.outcome_known || 0);
  const falsePositive = Number(row.false_positive_count || 0);
  const truePositive = Number(row.true_positive_count || 0);
  const falsePositiveRate = outcomeKnown > 0
    ? Number((falsePositive / outcomeKnown).toFixed(4))
    : null;

  return {
    guardName,
    days,
    totalTriggers: total,
    outcomeKnown,
    falsePositiveCount: falsePositive,
    truePositiveCount: truePositive,
    falsePositiveRate,
    avgPnlUsd: row.avg_pnl_usd != null ? Number(Number(row.avg_pnl_usd).toFixed(4)) : null,
    totalAbsPnlUsd: row.total_abs_pnl_usd != null ? Number(Number(row.total_abs_pnl_usd).toFixed(2)) : null,
    needsRelaxation: falsePositiveRate != null && falsePositiveRate > 0.30,
    needsTightening: falsePositiveRate != null && falsePositiveRate < 0.05 && total >= 10,
    insufficientData: outcomeKnown < 5,
  };
}

/**
 * 상위 가드 이벤트 샘플 조회 (LLM 분석용)
 */
async function fetchGuardEventSamples(guardName, days = 30, limit = 10) {
  const rows = await query(
    `SELECT
       triggered_at, symbol, reason, severity,
       outcome, outcome_pnl_usd, guard_metadata
     FROM investment.guard_events
    WHERE guard_name = $1
      AND triggered_at >= NOW() - $2::interval
    ORDER BY triggered_at DESC
    LIMIT $3`,
    [guardName, `${days} days`, limit],
  ).catch(() => []);
  return rows || [];
}

/**
 * LLM 분석 → 임계값 조정 추천
 */
export async function suggestThresholdAdjustment(guardName, days = 30) {
  const effectiveness = await measureGuardEffectiveness(guardName, days);
  const samples = await fetchGuardEventSamples(guardName, days);

  if (effectiveness.insufficientData) {
    return {
      guardName,
      recommendation: 'insufficient_data',
      reasoning: `데이터 부족 (결과 있는 이벤트 ${effectiveness.outcomeKnown}건, 최소 5건 필요)`,
      effectiveness,
      suggestedThreshold: null,
    };
  }

  // LLM 분석 시도
  let llmReasoning = null;
  let suggestedThreshold = null;
  try {
    const cfg = getPosttradeFeedbackRuntimeConfig();
    const llmEnabled = cfg?.guard_self_tuning?.llm_enabled !== false;
    if (llmEnabled) {
      const prompt = buildSelfTuningPrompt(guardName, effectiveness, samples);
      const llmResult = await callLLM({
        model: 'local_fast',
        prompt,
        maxTokens: 512,
      }).catch(() => null);
      if (llmResult?.content) {
        try {
          const parsed = JSON.parse(
            String(llmResult.content).match(/\{[\s\S]*\}/)?.[0] || '{}',
          );
          llmReasoning = parsed.reasoning || llmResult.content;
          suggestedThreshold = parsed.suggestedThreshold || null;
        } catch {
          llmReasoning = String(llmResult.content).slice(0, 500);
        }
      }
    }
  } catch {
    llmReasoning = null;
  }

  const action = effectiveness.needsRelaxation
    ? 'relax'
    : effectiveness.needsTightening
      ? 'tighten'
      : 'maintain';

  return {
    guardName,
    recommendation: action,
    reasoning: llmReasoning || buildRuleBasedReasoning(effectiveness, action),
    effectiveness,
    suggestedThreshold,
    shadowModeRequired: true,
    shadowDurationDays: 7,
  };
}

function buildRuleBasedReasoning(effectiveness, action) {
  const fp = effectiveness.falsePositiveRate != null
    ? `${(effectiveness.falsePositiveRate * 100).toFixed(1)}%`
    : 'N/A';
  if (action === 'relax') {
    return `False positive 비율 ${fp} > 30%: 가드가 성공할 거래를 과도하게 차단 중. 임계값 완화 권장.`;
  }
  if (action === 'tighten') {
    return `False positive 비율 ${fp} < 5%: 가드가 항상 맞음. 임계값 강화하여 더 많은 위험 차단 가능.`;
  }
  return `False positive 비율 ${fp}: 현재 임계값 적절. 유지 권장.`;
}

function buildSelfTuningPrompt(guardName, effectiveness, samples) {
  return `
루나 자동매매 시스템의 가드 자율 조정 분석을 수행한다.

가드: ${guardName}
분석 기간: ${effectiveness.days}일
총 트리거: ${effectiveness.totalTriggers}건
결과 확인됨: ${effectiveness.outcomeKnown}건
False positive 비율: ${effectiveness.falsePositiveRate != null ? (effectiveness.falsePositiveRate * 100).toFixed(1) : 'N/A'}%
평균 PnL 영향: ${effectiveness.avgPnlUsd != null ? effectiveness.avgPnlUsd : 'N/A'} USD

최근 샘플:
${samples.slice(0, 5).map((s) => `- ${s.triggered_at?.slice(0, 10)} ${s.symbol || ''}: ${s.reason} → ${s.outcome || 'pending'}`).join('\n')}

분석 요청:
1. 이 가드의 임계값 조정이 필요한가?
2. 조정한다면 어떤 방향으로 (relax/tighten)?
3. 구체적인 임계값 변경 제안

JSON 형식으로 응답:
{"recommendation": "relax|tighten|maintain", "reasoning": "...", "suggestedThreshold": {"param": "...", "currentValue": ..., "suggestedValue": ...}}
`.trim();
}

/**
 * 임계값 조정 이력 저장 (Shadow Mode 시작)
 */
export async function saveThresholdSuggestion(suggestion) {
  await ensureSelfTuningTable();
  await run(
    `INSERT INTO ${SELF_TUNING_TABLE}
       (guard_name, days_analyzed, total_triggers, false_positive_rate,
        suggested_threshold, llm_reasoning, shadow_mode, shadow_start_at, shadow_end_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, true, NOW(), NOW() + INTERVAL '7 days')`,
    [
      suggestion.guardName,
      suggestion.effectiveness?.days || 30,
      suggestion.effectiveness?.totalTriggers || 0,
      suggestion.effectiveness?.falsePositiveRate || null,
      suggestion.suggestedThreshold ? JSON.stringify(suggestion.suggestedThreshold) : null,
      suggestion.reasoning || null,
    ],
  ).catch(() => null);
}

/**
 * 마스터 승인 후 임계값 적용 (환경변수 기반 임계값 업데이트)
 * 실제 코드 수정은 안전상 마스터가 직접 수행.
 * 이 함수는 승인 기록만 DB에 남긴다.
 */
export async function applyThresholdAdjustment(guardName, newThreshold, tuningId = null) {
  await ensureSelfTuningTable();
  if (tuningId) {
    await run(
      `UPDATE ${SELF_TUNING_TABLE}
          SET master_approved = true,
              applied_at = NOW(),
              shadow_mode = false
        WHERE id = $1`,
      [tuningId],
    ).catch(() => null);
  }
  return {
    guardName,
    applied: true,
    appliedAt: new Date().toISOString(),
    newThreshold,
    note: '임계값 환경변수 수동 업데이트 필요 (마스터 직접 적용)',
  };
}

/**
 * 모든 활성 가드의 효과 측정 + 조정 필요 여부 요약
 */
export async function runWeeklySelfTuningAnalysis(days = 30) {
  const guardNames = await query(
    `SELECT DISTINCT guard_name
       FROM investment.guard_events
      WHERE triggered_at >= NOW() - $1::interval`,
    [`${days} days`],
  ).catch(() => []);

  const results = [];
  for (const row of (guardNames || [])) {
    const suggestion = await suggestThresholdAdjustment(row.guard_name, days);
    await saveThresholdSuggestion(suggestion);
    results.push(suggestion);
  }

  const needsAction = results.filter((r) => r.recommendation !== 'maintain' && r.recommendation !== 'insufficient_data');
  return {
    analyzedGuards: results.length,
    needsActionCount: needsAction.length,
    results,
    summaryAt: new Date().toISOString(),
  };
}

export default {
  measureGuardEffectiveness,
  suggestThresholdAdjustment,
  saveThresholdSuggestion,
  applyThresholdAdjustment,
  runWeeklySelfTuningAnalysis,
};
