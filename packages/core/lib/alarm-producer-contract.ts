'use strict';

/**
 * alarm-producer-contract.ts — Hub 알람 표준 계약
 *
 * 모든 22개 producer가 이 계약을 사용하면 fingerprint dedup + 분류 정확도가 향상된다.
 * Phase F (Phase A-10 요구사항).
 */

const { postAlarm } = require('./hub-alarm-client');

export type AlarmSeverity = 'info' | 'warn' | 'error' | 'critical';
export type AlarmType = 'work' | 'report' | 'error' | 'critical';
export type AlarmVisibility = 'internal' | 'audit_only' | 'digest' | 'notify' | 'human_action' | 'emergency';
export type AlarmActionability = 'none' | 'auto_repair' | 'needs_approval' | 'needs_human';

export interface AlarmEnvelope {
  // 필수
  team: string;
  bot_name: string;
  severity: AlarmSeverity;
  title: string;        // ≤ 80 chars
  message: string;      // ≤ 500 chars (detail은 payload에)

  // 분류 힌트 (Layer 2)
  alarm_type?: AlarmType;
  visibility?: AlarmVisibility;
  actionability?: AlarmActionability;

  // dedup 힌트 (Layer 3)
  fingerprint_components?: string[];
  digest_window_minutes?: number;

  // enrichment
  event_type?: string;
  payload?: Record<string, unknown>;
  runbook_url?: string;

  // tracking
  incident_key?: string;
  trace_id?: string;
}

const VALID_SEVERITIES: AlarmSeverity[] = ['info', 'warn', 'error', 'critical'];
const VALID_TYPES: AlarmType[] = ['work', 'report', 'error', 'critical'];
const VALID_VISIBILITIES: AlarmVisibility[] = ['internal', 'audit_only', 'digest', 'notify', 'human_action', 'emergency'];
const VALID_ACTIONABILITIES: AlarmActionability[] = ['none', 'auto_repair', 'needs_approval', 'needs_human'];

export function validateAlarmEnvelope(input: unknown): AlarmEnvelope {
  if (!input || typeof input !== 'object') {
    throw new TypeError('AlarmEnvelope must be an object');
  }
  const env = input as Record<string, unknown>;

  const team = String(env.team || '').trim();
  if (!team) throw new TypeError('AlarmEnvelope.team is required');

  const bot_name = String(env.bot_name || '').trim();
  if (!bot_name) throw new TypeError('AlarmEnvelope.bot_name is required');

  const severity = String(env.severity || 'warn') as AlarmSeverity;
  if (!VALID_SEVERITIES.includes(severity)) {
    throw new TypeError(`AlarmEnvelope.severity must be one of: ${VALID_SEVERITIES.join(', ')}`);
  }

  const title = String(env.title || '').slice(0, 80).trim();
  if (!title) throw new TypeError('AlarmEnvelope.title is required');

  const message = String(env.message || '').slice(0, 500).trim();
  if (!message) throw new TypeError('AlarmEnvelope.message is required');

  const result: AlarmEnvelope = { team, bot_name, severity, title, message };

  if (env.alarm_type !== undefined) {
    const t = String(env.alarm_type) as AlarmType;
    if (VALID_TYPES.includes(t)) result.alarm_type = t;
  }
  if (env.visibility !== undefined) {
    const v = String(env.visibility) as AlarmVisibility;
    if (VALID_VISIBILITIES.includes(v)) result.visibility = v;
  }
  if (env.actionability !== undefined) {
    const a = String(env.actionability) as AlarmActionability;
    if (VALID_ACTIONABILITIES.includes(a)) result.actionability = a;
  }
  if (Array.isArray(env.fingerprint_components)) {
    result.fingerprint_components = env.fingerprint_components.map(String).slice(0, 8);
  }
  if (typeof env.digest_window_minutes === 'number' && env.digest_window_minutes > 0) {
    result.digest_window_minutes = Math.min(1440, env.digest_window_minutes);
  }
  if (env.event_type) result.event_type = String(env.event_type);
  if (env.payload && typeof env.payload === 'object') result.payload = env.payload as Record<string, unknown>;
  if (env.runbook_url) result.runbook_url = String(env.runbook_url);
  if (env.incident_key) result.incident_key = String(env.incident_key);
  if (env.trace_id) result.trace_id = String(env.trace_id);

  return result;
}

export async function postStandardizedAlarm(envelope: AlarmEnvelope): Promise<{ ok: boolean; error?: string }> {
  try {
    const valid = validateAlarmEnvelope(envelope);
    const payload: Record<string, unknown> = { ...(valid.payload || {}) };
    if (valid.fingerprint_components?.length) {
      payload.fingerprint_components = valid.fingerprint_components;
    }
    if (valid.digest_window_minutes) {
      payload.digest_window_minutes = valid.digest_window_minutes;
    }
    if (valid.runbook_url) payload.runbook_url = valid.runbook_url;
    if (valid.trace_id) payload.trace_id = valid.trace_id;

    const result = await postAlarm({
      team: valid.team,
      fromBot: valid.bot_name,
      alertLevel: valid.severity === 'critical' ? 4 : valid.severity === 'error' ? 3 : valid.severity === 'warn' ? 2 : 1,
      alarmType: valid.alarm_type,
      visibility: valid.visibility,
      actionability: valid.actionability,
      title: valid.title,
      message: valid.message,
      eventType: valid.event_type,
      incidentKey: valid.incident_key,
      payload,
    });
    return result?.ok ? { ok: true } : { ok: false, error: result?.error || 'unknown' };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

module.exports = {
  validateAlarmEnvelope,
  postStandardizedAlarm,
};
