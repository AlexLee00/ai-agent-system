'use strict';

const ALARM_TYPES = ['work', 'report', 'error', 'critical'] as const;

type AlarmType = (typeof ALARM_TYPES)[number];

function normalizeText(value: unknown, fallback = ''): string {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}


export function normalizeAlarmType(value: unknown): AlarmType | null {
  const normalized = normalizeText(value).toLowerCase().replace(/[-\s]+/g, '_');
  if (!normalized) return null;
  if (normalized === 'operational' || normalized === 'operation' || normalized === 'process' || normalized === 'completion') return 'work';
  if (normalized === 'reporting' || normalized === 'digest' || normalized === 'summary') return 'report';
  if (normalized === 'failure' || normalized === 'incident') return 'error';
  if (normalized === 'critical' || normalized === 'urgent' || normalized === 'emergency') return 'critical';
  return ALARM_TYPES.includes(normalized as AlarmType) ? (normalized as AlarmType) : null;
}

const REPORT_SIGNALS = [
  'report', 'digest', 'summary', 'daily', 'weekly', 'monthly', 'readiness', 'dashboard',
  '리포트', '보고', '정기 보고', '주간', '일간', '월간', '회고', '브리핑',
];

const ERROR_SIGNALS = [
  'error', 'failed', 'failure', 'exception', 'timeout', 'unhandled', 'panic', 'fatal',
  'provider_cooldown', '오류', '실패', '장애', '예외', '타임아웃', '미해결',
];

function classifyOperationalSnapshot({
  eventType,
  title,
  message,
}: {
  eventType?: unknown;
  title?: unknown;
  message?: unknown;
}): { type: AlarmType; confidence: number } | null {
  const event = normalizeText(eventType).toLowerCase();
  const titleText = normalizeText(title);
  const messageText = normalizeText(message);
  const corpus = `${event}\n${titleText}\n${messageText}`;
  const lower = corpus.toLowerCase();

  if (event === 'alert'
    && lower.includes('🆕 신규 예약 감지')
    && lower.includes('자동 등록 준비 중')) {
    return { type: 'report', confidence: 0.97 };
  }

  if (/blog-commenter|blog-neighbor-commenter|blog-neighbor-sympathy/.test(lower)
    && lower.includes('실패 0건')) {
    return { type: 'report', confidence: 0.95 };
  }

  if (lower.includes('[블로팀] 인스타 일일 현황')
    || lower.includes('engagement 자동화 회복')) {
    return { type: 'report', confidence: 0.94 };
  }

  if (event === 'alert'
    && lower.includes('👀 포지션 watch')
    && lower.includes('autopilot: position_runtime_autopilot_ready')) {
    return { type: 'report', confidence: 0.95 };
  }

  if (event === 'agent_memory_route_quality'
    && lower.includes('route_quality_attention')) {
    return { type: 'report', confidence: 0.94 };
  }

  if ((event === 'auto_dev_stage_plan' || event === 'auto_dev_stage_failed')
    && lower.includes('🤖 클로드팀 auto_dev')) {
    return { type: 'work', confidence: 0.98 };
  }

  if (event === 'system'
    && lower.includes('⚠️ 덱스터 감지 (퀵체크)')
    && lower.includes('자동 재시작 완료')) {
    return { type: 'report', confidence: 0.95 };
  }

  if (event === 'health_check'
    && lower.includes('[클로드 헬스]')
    && lower.includes('auto-dev.autonomous 다운')) {
    return { type: 'report', confidence: 0.92 };
  }

  return null;
}

export function classifyAlarmTypeWithConfidence({
  requestedType,
  severity,
  eventType,
  title,
  message,
  payload,
}: {
  requestedType?: unknown;
  severity?: unknown;
  eventType?: unknown;
  title?: unknown;
  message?: unknown;
  payload?: unknown;
}): { type: AlarmType; confidence: number } {
  const explicit = normalizeAlarmType(requestedType);
  if (explicit) return { type: explicit, confidence: 1.0 };

  const payloadType = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? normalizeAlarmType((payload as Record<string, unknown>).alarm_type || (payload as Record<string, unknown>).alarmType)
    : null;
  if (payloadType) return { type: payloadType, confidence: 1.0 };

  const severityText = normalizeText(severity).toLowerCase();
  if (severityText === 'critical') return { type: 'critical', confidence: 0.9 };

  const corpus = [
    normalizeText(eventType),
    normalizeText(title),
    normalizeText(message),
  ].join('\n').toLowerCase();

  const snapshot = classifyOperationalSnapshot({ eventType, title, message });
  if (snapshot) return snapshot;

  const reportMatches = REPORT_SIGNALS.filter((s) => corpus.includes(s)).length;
  if (reportMatches >= 2) return { type: 'report', confidence: 0.9 };
  if (reportMatches >= 1) return { type: 'report', confidence: 0.8 };

  const errorMatches = ERROR_SIGNALS.filter((s) => corpus.includes(s)).length;
  if (errorMatches >= 2) return { type: 'error', confidence: 0.9 };
  if (errorMatches >= 1) return { type: 'error', confidence: 0.8 };

  if (severityText === 'warn' || severityText === 'error') return { type: 'error', confidence: 0.75 };

  return { type: 'work', confidence: 0.5 };
}

export function classifyAlarmType({
  requestedType,
  severity,
  eventType,
  title,
  message,
  payload,
}: {
  requestedType?: unknown;
  severity?: unknown;
  eventType?: unknown;
  title?: unknown;
  message?: unknown;
  payload?: unknown;
}): AlarmType {
  return classifyAlarmTypeWithConfidence({ requestedType, severity, eventType, title, message, payload }).type;
}

export function isExplicitHumanEscalation({
  requestedVisibility,
  requestedActionability,
  payload,
}: {
  requestedVisibility?: unknown;
  requestedActionability?: unknown;
  payload?: unknown;
}): boolean {
  const visibility = normalizeText(requestedVisibility).toLowerCase();
  const actionability = normalizeText(requestedActionability).toLowerCase();
  if (visibility === 'emergency' || visibility === 'human_action') return true;
  if (actionability === 'needs_human' || actionability === 'needs_approval') return true;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const flag = normalizeText(record.escalate_to_human || record.escalateToHuman).toLowerCase();
    return ['1', 'true', 'yes', 'y', 'on'].includes(flag);
  }
  return false;
}

module.exports = {
  ALARM_TYPES,
  classifyAlarmType,
  classifyAlarmTypeWithConfidence,
  isExplicitHumanEscalation,
  normalizeAlarmType,
};
