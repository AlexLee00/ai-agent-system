// @ts-nocheck

import path from 'path';
import { fileURLToPath } from 'url';

const INVESTMENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export const MEETING_ROOM_DEFAULTS = Object.freeze({
  type: 'morning',
  chair: 'luna',
  maxLlmCallsPerMeeting: 6,
  maxTokensPerUtterance: 512,
  llmTimeoutMs: 45_000,
  decisionDueHours: 24,
  outputDir: path.join(INVESTMENT_ROOT, 'output', 'meeting-room'),
  analysisAgents: Object.freeze(['sophia', 'aria']),
  grillQuestions: Object.freeze([
    '이 결정의 가장 강한 반대 논거는 무엇인가?',
    '어떤 데이터가 나오면 이 결정은 무효인가?',
    '마스터라면 무엇을 물을까?',
    '지금 결정하지 않으면 잃는 것은 무엇인가?',
    '과거 같은 유형 결정의 결과는 어땠는가?',
  ]),
});

export function normalizeMeetingType(value: any = MEETING_ROOM_DEFAULTS.type) {
  const raw = String(value || MEETING_ROOM_DEFAULTS.type).trim();
  return ['morning', 'domestic_debrief', 'us_premarket', 'weekly', 'adhoc'].includes(raw)
    ? raw
    : MEETING_ROOM_DEFAULTS.type;
}

export function normalizeChair(value: any = MEETING_ROOM_DEFAULTS.chair) {
  const raw = String(value || MEETING_ROOM_DEFAULTS.chair).trim();
  return raw === 'master' ? 'master' : 'luna';
}

export function meetingRoomConfig(overrides: any = {}) {
  return {
    ...MEETING_ROOM_DEFAULTS,
    ...(overrides || {}),
    type: normalizeMeetingType(overrides.type || MEETING_ROOM_DEFAULTS.type),
    chair: normalizeChair(overrides.chair || MEETING_ROOM_DEFAULTS.chair),
    maxLlmCallsPerMeeting: Math.max(0, Number(overrides.maxLlmCallsPerMeeting ?? MEETING_ROOM_DEFAULTS.maxLlmCallsPerMeeting)),
    maxTokensPerUtterance: Math.max(64, Number(overrides.maxTokensPerUtterance ?? MEETING_ROOM_DEFAULTS.maxTokensPerUtterance)),
    decisionDueHours: Math.max(1, Number(overrides.decisionDueHours ?? MEETING_ROOM_DEFAULTS.decisionDueHours)),
  };
}

export default {
  MEETING_ROOM_DEFAULTS,
  meetingRoomConfig,
  normalizeMeetingType,
  normalizeChair,
};
