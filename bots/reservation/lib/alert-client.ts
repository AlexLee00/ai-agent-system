import os from 'os';
import path from 'path';
import { publishToWebhook } from '../../../packages/core/lib/reporting-hub';
import { updateCriticalIncidentCache } from '../../../packages/core/lib/critical-incident';

export interface PublishReservationAlertOptions {
  from_bot?: string;
  team?: string;
  event_type?: string;
  alert_level?: number;
  message: string;
  payload?: Record<string, unknown> | null;
}

const ALERT_DEDUPE_PATH = path.join(os.tmpdir(), 'reservation-alert-dedupe.json');
const ALERT_DEDUPE_WINDOW_MS = 15 * 60 * 1000;

function classifyReason(message: string): string {
  const compact = String(message || '').replace(/\s+/g, ' ').trim();
  if (/write EPIPE|broken pipe|stdout broken pipe|stderr broken pipe/i.test(compact)) {
    return 'broken_pipe';
  }
  if (/SIGTERM 수신/i.test(compact)) {
    return 'sigterm_shutdown';
  }
  const reasonMatch = compact.match(/사유:\s*(.+)$/);
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
}: Pick<PublishReservationAlertOptions, 'team' | 'event_type' | 'alert_level' | 'message'>): string | null {
  if (alert_level == null || alert_level < 3) return null;
  if (event_type !== 'system_error') return null;

  return `${team || 'reservation'}|${event_type}|${classifyReason(message)}`;
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
    logPrefix: 'publishReservationAlert',
  });
}

export async function publishReservationAlert({
  from_bot,
  team = 'reservation',
  event_type,
  alert_level = 2,
  message,
  payload,
}: PublishReservationAlertOptions): Promise<boolean> {
  if (process.env.TELEGRAM_ENABLED === '0') {
    console.log('[publishReservationAlert] suppressed by TELEGRAM_ENABLED=0');
    return true;
  }

  const signature = normalizeAlertSignature({ team, event_type, alert_level, message });
  const incidentState = updateIncidentCache(signature, message);
  if (incidentState.suppress) {
    console.log(`[publishReservationAlert] duplicate suppressed: ${signature} (#${incidentState.incident?.count || 1})`);
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

  const result = await publishToWebhook({
    event: {
      from_bot: from_bot || 'ska',
      team,
      event_type,
      alert_level,
      message: lines.filter(Boolean).join('\n'),
      payload: payload || undefined,
    },
  });
  return result.ok === true;
}

export const publishAlert = publishReservationAlert;
/**
 * @deprecated Use publishAlert or publishReservationAlert instead.
 */
export const publishToMainBot = publishReservationAlert;
