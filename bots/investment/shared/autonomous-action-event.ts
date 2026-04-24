// @ts-nocheck

export const AUTONOMOUS_ACTION_EVENT_TYPES = new Set([
  'autonomous_action_executed',
  'autonomous_action_queued',
  'autonomous_action_retrying',
  'autonomous_action_blocked_by_safety',
  'autonomous_action_failed',
]);

export function normalizeAutonomousActionEventType(value = null, fallback = null) {
  const normalized = String(value || '').trim().toLowerCase();
  if (AUTONOMOUS_ACTION_EVENT_TYPES.has(normalized)) return normalized;
  return fallback;
}

export function inferAutonomousActionEventTypeFromMessage(message = '') {
  const text = String(message || '');
  const inline = text.match(/action status:\s*([a-z0-9_:-]+)/i);
  return normalizeAutonomousActionEventType(inline?.[1], null);
}

export function enrichAutonomousActionAlertPayload(payload = null, message = '') {
  if (!payload || typeof payload !== 'object') return payload;
  const explicit = normalizeAutonomousActionEventType(payload.event_type, null);
  const fromStatus = normalizeAutonomousActionEventType(payload.autonomousActionStatus, null);
  const inferred = inferAutonomousActionEventTypeFromMessage(message);
  const normalized = explicit || fromStatus || inferred;
  if (!normalized) return payload;
  return {
    ...payload,
    event_type: normalized,
    autonomousActionStatus: normalized,
  };
}

export function resolveAutonomousActionAlertEventType(payload = null, fallback = 'health_check') {
  if (!payload || typeof payload !== 'object') return fallback;
  const normalized = normalizeAutonomousActionEventType(payload.event_type, null)
    || normalizeAutonomousActionEventType(payload.autonomousActionStatus, null);
  return normalized || fallback;
}
