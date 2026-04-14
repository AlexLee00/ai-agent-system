import { publishToWebhook } from '../../../packages/core/lib/reporting-hub';

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
