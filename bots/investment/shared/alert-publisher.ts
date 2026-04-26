// @ts-nocheck
/**
 * shared/alert-publisher.ts — 루나팀 알람 발행 클라이언트 (ESM)
 *
 * Hub alarm 경유로 전달한다.
 */

import { createRequire } from 'module';
import os from 'os';
import path from 'path';

const require  = createRequire(import.meta.url);
const { publishToWebhook } = require('../../../packages/core/lib/reporting-hub');
const { updateCriticalIncidentCache } = require('./critical-incident-bridge.cjs');

const ALERT_DEDUPE_PATH = path.join(os.tmpdir(), 'investment-alert-dedupe.json');
const ALERT_DEDUPE_WINDOW_MS = 15 * 60 * 1000;

type PublishAlertOptions = {
  from_bot: string;
  team?: string;
  event_type: string;
  alert_level?: number;
  message: string;
  payload?: Record<string, unknown>;
};

function classifyReason(message: string): string {
  const compact = String(message || '').replace(/\s+/g, ' ').trim();
  const reasonMatch = compact.match(/(?:사유|reason):\s*(.+)$/i);
  const reason = reasonMatch ? reasonMatch[1].trim() : compact;
  return reason
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9가-힣_:-]/g, '')
    .slice(0, 80) || 'unknown';
}

function normalizeAlertSignature({
  team,
  event_type,
  alert_level,
  message,
}: Pick<PublishAlertOptions, 'team' | 'event_type' | 'alert_level' | 'message'>): string | null {
  if (alert_level == null || alert_level < 3) return null;
  if (event_type !== 'system_error') return null;
  return `${team || 'investment'}|${event_type}|${classifyReason(message)}`;
}

function updateIncidentCache(signature: string | null, message: string): {
  suppress: boolean;
  incident: null | {
    count: number;
    first_seen_at: string;
    last_seen_at: string;
    latest_reason: string;
  };
} {
  return updateCriticalIncidentCache({
    cachePath: ALERT_DEDUPE_PATH,
    signature,
    message,
    latestReason: classifyReason(message),
    windowMs: ALERT_DEDUPE_WINDOW_MS,
    logPrefix: 'alert-publisher',
  });
}

/**
 * Hub alarm으로 알람 발행
 * @param {object} opts
 * @param {string} opts.from_bot     발신 봇 ID (luna, jason, tyler, molly, chris...)
 * @param {string} [opts.team]       팀명 (기본: investment)
 * @param {string} opts.event_type   이벤트 유형 (trade|alert|system|report)
 * @param {number} [opts.alert_level] 1~4 (기본: 2=MEDIUM)
 * @param {string} opts.message      사람이 읽는 메시지
 * @param {object} [opts.payload]    JSON 구조화 데이터
 */
export async function publishAlert({ from_bot, team = 'investment', event_type, alert_level = 2, message, payload }: PublishAlertOptions) {
  const signature = normalizeAlertSignature({ team, event_type, alert_level, message });
  const incidentState = updateIncidentCache(signature, message);
  if (incidentState.suppress) {
    console.log(`[alert-publisher] duplicate suppressed: ${signature} (#${incidentState.incident?.count || 1})`);
    return true;
  }

  const lines = [message];
  if (incidentState.incident && signature) {
    lines.push(
      `incident: canonical=1 count=${incidentState.incident.count} first_seen=${incidentState.incident.first_seen_at} last_seen=${incidentState.incident.last_seen_at} reason=${incidentState.incident.latest_reason}`
    );
  }
  if (payload && typeof payload === 'object') {
    lines.push(`payload: ${JSON.stringify(payload)}`);
  }
  if (event_type) {
    lines.push(`event_type: ${event_type}`);
  }

  const event = { from_bot, team, event_type, alert_level, message: lines.filter(Boolean).join('\n'), payload };

  const webhookResult = await publishToWebhook({
    event,
    policy: {
      cooldownMs: 2 * 60_000,
    },
  });

  if (webhookResult.ok && !webhookResult.skipped) {
    return true;
  }
  console.warn(`[alert-publisher] webhook 실패/스킵: ${webhookResult.error || webhookResult.reason || 'unknown'}`);
  return false;
}

/**
 * @deprecated Use publishAlert instead.
 */
export const publishToMainBot = publishAlert;
