'use strict';

const { callWithFallback } = require('../../../../packages/core/lib/llm-fallback');
const { selectLLMChain } = require('../../../../packages/core/lib/llm-model-selector');

const ALARM_TYPES = ['work', 'report', 'error', 'critical'] as const;
type AlarmType = (typeof ALARM_TYPES)[number];

let dailyCount = 0;
let dailyResetDate = '';

function isEnabled(): boolean {
  const raw = String(process.env.HUB_ALARM_LLM_CLASSIFIER_ENABLED || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw);
}

function checkAndIncrementDailyCount(): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (dailyResetDate !== today) {
    dailyCount = 0;
    dailyResetDate = today;
  }
  const limit = Math.max(1, Number(process.env.HUB_ALARM_LLM_DAILY_LIMIT || 100) || 100);
  if (dailyCount >= limit) return false;
  dailyCount++;
  return true;
}

const SYSTEM_PROMPT = `당신은 알람 분류 에이전트입니다. 알람을 4가지 유형 중 하나로 분류하세요.

유형:
- work: 정상 작업 완료 (거래 실행, 배포 완료, 스케줄 실행)
- report: 통계/현황 리포트 (일간/주간 요약, 대시보드)
- error: 수정 가능한 오류 (API timeout, 처리 실패, 임시 장애)
- critical: 즉각적 인간 개입 필요 (실거래 자금 위험, 시스템 다운, 복구 불가)

JSON으로만 응답하세요:
{"type": "work|report|error|critical", "confidence": 0.0-1.0, "reason": "한 줄 이유"}`;

export async function classifyAlarmWithLLM({
  team,
  severity,
  title,
  message,
  eventType,
}: {
  team: string;
  severity: string;
  title: string;
  message: string;
  eventType?: string;
}): Promise<{ type: AlarmType; confidence: number; source: 'llm' } | null> {
  if (!isEnabled()) return null;
  if (!checkAndIncrementDailyCount()) return null;

  let chain: any[];
  try {
    chain = selectLLMChain('hub.alarm.classifier');
  } catch {
    return null;
  }

  const userPrompt = [
    `team: ${team}`,
    `severity: ${severity}`,
    `title: ${title}`,
    `message: ${message.slice(0, 500)}`,
    eventType ? `event_type: ${eventType}` : '',
  ].filter(Boolean).join('\n');

  try {
    const result = await callWithFallback({
      chain,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      logMeta: { team: 'hub', bot: 'alarm-classifier', requestType: 'alarm_classification', selectorKey: 'hub.alarm.classifier' },
    });
    if (!result?.text) return null;
    const text = result.text.trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
    const parsed = JSON.parse(text);
    const type = ALARM_TYPES.includes(parsed?.type) ? (parsed.type as AlarmType) : null;
    if (!type) return null;
    const confidence = Math.max(0, Math.min(1, Number(parsed?.confidence) || 0.5));
    return { type, confidence, source: 'llm' };
  } catch {
    return null;
  }
}

export function getDailyClassifierCount(): number {
  return dailyCount;
}

module.exports = { classifyAlarmWithLLM, getDailyClassifierCount };
