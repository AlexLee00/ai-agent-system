'use strict';

const { callWithFallback } = require('../../../../packages/core/lib/llm-fallback');
const { selectLLMChain } = require('../../../../packages/core/lib/llm-model-selector');

let dailyCount = 0;
let dailyResetDate = '';

function isEnabled(): boolean {
  const raw = String(process.env.HUB_ALARM_INTERPRETER_ENABLED || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw);
}

function isFailOpen(): boolean {
  const raw = String(process.env.HUB_ALARM_INTERPRETER_FAIL_OPEN ?? 'true').trim().toLowerCase();
  return !['0', 'false', 'no', 'n', 'off'].includes(raw);
}

function checkAndIncrementDailyCount(): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (dailyResetDate !== today) {
    dailyCount = 0;
    dailyResetDate = today;
  }
  const limit = Math.max(1, Number(process.env.HUB_ALARM_INTERPRETER_LLM_DAILY_LIMIT || 200) || 200);
  if (dailyCount >= limit) return false;
  dailyCount++;
  return true;
}

export interface AlarmInterpretation {
  summary: string;
  actionRecommendation?: string;
  rootCauseCandidates?: string[];
  impactScope?: string;
}

type InterpreterConfig = {
  selectorKey: string;
  systemPrompt: string;
};

const INTERPRETER_CONFIGS: Record<string, InterpreterConfig> = {
  work: {
    selectorKey: 'hub.alarm.interpreter.work',
    systemPrompt: `작업 완료 알람을 한 줄로 요약하세요. (50자 이내)
JSON으로만 응답: {"summary": "🟢 [{team}] {핵심내용}"}`,
  },
  report: {
    selectorKey: 'hub.alarm.interpreter.report',
    systemPrompt: `리포트 알람의 핵심 수치를 요약하세요. (80자 이내)
JSON으로만 응답: {"summary": "📊 [{team}] {수치요약}"}`,
  },
  error: {
    selectorKey: 'hub.alarm.interpreter.error',
    systemPrompt: `오류 알람을 분석하세요.
JSON으로만 응답:
{"summary": "🟠 [{team}] {오류명}: {한줄요약}", "action_recommendation": "즉시 필요한 액션", "root_cause_candidates": ["원인1", "원인2", "원인3"]}`,
  },
  critical: {
    selectorKey: 'hub.alarm.interpreter.critical',
    systemPrompt: `긴급 알람을 분석하세요.
JSON으로만 응답:
{"summary": "🔴 [{team}] 긴급: {상황요약}", "action_recommendation": "즉각적인 액션", "impact_scope": "영향 범위"}`,
  },
};

export async function interpretAlarm({
  alarmType,
  team,
  severity,
  title,
  message,
}: {
  alarmType: string;
  team: string;
  severity: string;
  title: string;
  message: string;
}): Promise<AlarmInterpretation | null> {
  if (!isEnabled()) return null;
  if (!checkAndIncrementDailyCount()) return null;

  const config = INTERPRETER_CONFIGS[alarmType] || INTERPRETER_CONFIGS.work;

  let chain: any[];
  try {
    chain = selectLLMChain(config.selectorKey);
  } catch {
    return null;
  }

  const userPrompt = [
    `team: ${team}`,
    `severity: ${severity}`,
    `title: ${title}`,
    `message: ${message.slice(0, 800)}`,
  ].join('\n');

  try {
    const result = await callWithFallback({
      chain,
      systemPrompt: config.systemPrompt,
      userPrompt,
      logMeta: { team: 'hub', bot: `alarm-interpreter-${alarmType}`, requestType: 'alarm_interpretation', selectorKey: config.selectorKey },
    });
    if (!result?.text) return isFailOpen() ? null : null;
    const text = result.text.trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
    const parsed = JSON.parse(text);
    if (!parsed?.summary) return null;
    return {
      summary: String(parsed.summary),
      actionRecommendation: parsed.action_recommendation ? String(parsed.action_recommendation) : undefined,
      rootCauseCandidates: Array.isArray(parsed.root_cause_candidates)
        ? parsed.root_cause_candidates.map(String).slice(0, 3)
        : undefined,
      impactScope: parsed.impact_scope ? String(parsed.impact_scope) : undefined,
    };
  } catch {
    return null;
  }
}

export function getDailyInterpreterCount(): number {
  return dailyCount;
}

module.exports = { interpretAlarm, getDailyInterpreterCount };
