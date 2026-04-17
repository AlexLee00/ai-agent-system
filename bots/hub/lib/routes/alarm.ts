const eventLake = require('../../../../packages/core/lib/event-lake');
const telegramSender = require('../../../../packages/core/lib/telegram-sender');

function normalizeText(value: unknown, fallback = ''): string {
  const normalized = String(value == null ? fallback : value).trim();
  return normalized || fallback;
}

function normalizeSeverity(value: unknown): 'info' | 'warn' | 'error' | 'critical' {
  const normalized = normalizeText(value, 'info').toLowerCase();
  return ['info', 'warn', 'error', 'critical'].includes(normalized)
    ? (normalized as 'info' | 'warn' | 'error' | 'critical')
    : 'info';
}

function normalizeTeam(value: unknown): string {
  const normalized = normalizeText(value, 'general').toLowerCase();
  const aliases: Record<string, string> = {
    claude: 'claude',
    'claude-lead': 'claude-lead',
    investment: 'investment',
    luna: 'luna',
    reservation: 'reservation',
    ska: 'ska',
    meeting: 'meeting',
    emergency: 'emergency',
    blog: 'blog',
    general: 'general',
  };
  return aliases[normalized] || 'general';
}

export async function alarmRoute(req: any, res: any) {
  try {
    const message = normalizeText(req.body?.message);
    if (!message) {
      return res.status(400).json({ ok: false, error: 'message required' });
    }

    const team = normalizeTeam(req.body?.team);
    const fromBot = normalizeText(req.body?.fromBot, 'hub-alarm');
    const severity = normalizeSeverity(req.body?.severity);
    const title = normalizeText(req.body?.title, `${team} alarm`);
    const cooldownMinutes = Math.max(
      1,
      Number(req.body?.dedupeMinutes ?? req.body?.cooldownMinutes ?? 5) || 5,
    );

    const duplicate = await eventLake.findRecentDuplicateAlarm({
      team,
      botName: fromBot,
      message,
      minutes: cooldownMinutes,
    });

    if (duplicate) {
      return res.json({
        ok: true,
        deduped: true,
        event_id: duplicate.id,
        delivered: false,
        delivery_error: null,
      });
    }

    const eventId = await eventLake.record({
      eventType: 'hub_alarm',
      team,
      botName: fromBot,
      severity,
      title,
      message,
      tags: ['hub', 'alarm', `team:${team}`],
      metadata: {
        source: 'hub_alarm_route',
        fromBot,
      },
    });

    let delivered = false;
    let deliveryError = '';

    try {
      delivered = severity === 'critical'
        ? await telegramSender.sendCritical(team, message)
        : await telegramSender.send(team, message);
    } catch (error: any) {
      deliveryError = error?.message || 'telegram_send_failed';
    }

    return res.json({
      ok: true,
      event_id: eventId,
      delivered,
      delivery_error: deliveryError || null,
    });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}
