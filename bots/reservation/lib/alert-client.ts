import { postAlarm } from '../../../packages/core/lib/openclaw-client';

export interface PublishReservationAlertOptions {
  from_bot?: string;
  team?: string;
  event_type?: string;
  alert_level?: number;
  message: string;
  payload?: Record<string, unknown> | null;
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

  const lines = [message];
  if (payload && typeof payload === 'object') {
    lines.push(`payload: ${JSON.stringify(payload)}`);
  }
  if (event_type) {
    lines.push(`event_type: ${event_type}`);
  }

  const result = await postAlarm({
    message: lines.filter(Boolean).join('\n'),
    team,
    alertLevel: alert_level,
    fromBot: from_bot || 'ska',
  });
  return result.ok === true;
}

export const publishAlert = publishReservationAlert;
export const publishToMainBot = publishReservationAlert;
