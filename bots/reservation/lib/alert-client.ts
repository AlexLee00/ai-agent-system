import fs from 'fs';
import os from 'os';
import path from 'path';
import { publishToWebhook } from '../../../packages/core/lib/reporting-hub';

export interface PublishReservationAlertOptions {
  from_bot?: string;
  team?: string;
  event_type?: string;
  alert_level?: number;
  message: string;
  payload?: Record<string, unknown> | null;
}

const ALERT_DEDUPE_PATH = path.join(os.homedir(), '.openclaw', 'workspace', 'reservation-alert-dedupe.json');
const ALERT_DEDUPE_WINDOW_MS = 15 * 60 * 1000;

function normalizeAlertSignature({
  team,
  event_type,
  alert_level,
  message,
}: Pick<PublishReservationAlertOptions, 'team' | 'event_type' | 'alert_level' | 'message'>): string | null {
  if (alert_level == null || alert_level < 3) return null;
  if (event_type !== 'system_error') return null;

  const compact = String(message || '').replace(/\s+/g, ' ').trim();
  const reasonMatch = compact.match(/사유:\s*(.+)$/);
  const reason = reasonMatch ? reasonMatch[1].trim() : compact;
  return `${team || 'reservation'}|${event_type}|${reason}`;
}

function shouldSuppressDuplicateAlert(signature: string | null): boolean {
  if (!signature) return false;

  try {
    fs.mkdirSync(path.dirname(ALERT_DEDUPE_PATH), { recursive: true });
    let cache: Record<string, number> = {};

    if (fs.existsSync(ALERT_DEDUPE_PATH)) {
      cache = JSON.parse(fs.readFileSync(ALERT_DEDUPE_PATH, 'utf8') || '{}');
    }

    const now = Date.now();
    const recent = cache[signature];
    cache = Object.fromEntries(
      Object.entries(cache).filter(([, ts]) => now - Number(ts || 0) < ALERT_DEDUPE_WINDOW_MS)
    );

    if (recent && now - Number(recent) < ALERT_DEDUPE_WINDOW_MS) {
      fs.writeFileSync(ALERT_DEDUPE_PATH, JSON.stringify(cache, null, 2));
      return true;
    }

    cache[signature] = now;
    fs.writeFileSync(ALERT_DEDUPE_PATH, JSON.stringify(cache, null, 2));
  } catch (error) {
    console.warn(`[publishReservationAlert] dedupe cache 실패: ${String((error as Error)?.message || error)}`);
  }

  return false;
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
  if (shouldSuppressDuplicateAlert(signature)) {
    console.log(`[publishReservationAlert] duplicate suppressed: ${signature}`);
    return true;
  }

  const lines = [message];
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
