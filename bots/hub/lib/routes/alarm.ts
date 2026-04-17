const eventLake = require('../../../../packages/core/lib/event-lake');
const telegramSender = require('../../../../packages/core/lib/telegram-sender');

function alarmsDisabled(): boolean {
  // Temporary global kill switch per operator request.
  return true;
}
const pgPool = require('../../../../packages/core/lib/pg-pool');

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
    sigma: 'sigma',
    meeting: 'meeting',
    emergency: 'emergency',
    blog: 'blog',
    general: 'general',
  };
  return aliases[normalized] || 'general';
}

function _parseLunaBlogRequest(message: string): { regime: string; mood: string; keywordHints: string } | null {
  if (!message.includes('루나팀 시장 급변')) return null;
  const regimeMatch = message.match(/현재 체제: (\w+)/);
  const moodMatch = message.match(/현재 체제: \w+ \(([^)]+)\)/);
  const kwMatch = message.match(/키워드 힌트: (.+)/);
  const regime = regimeMatch?.[1] || 'volatile';
  const mood = moodMatch?.[1] || '시장 변화';
  const keywordHints = kwMatch?.[1]?.trim() || '';
  return { regime, mood, keywordHints };
}

async function _insertLunaBlogRequest(regime: string, mood: string, keywordHints: string, eventId: number | null): Promise<void> {
  const urgency = regime === 'crisis' ? 9 : regime === 'volatile' ? 7 : 5;
  await pgPool.run('blog', `
    INSERT INTO blog.content_requests
      (source_team, regime, mood, keyword_hints, urgency, status, expires_at, metadata)
    VALUES
      ('luna', $1, $2, $3, $4, 'pending', NOW() + INTERVAL '24 hours', $5::jsonb)
  `, [
    regime,
    mood,
    keywordHints || null,
    urgency,
    JSON.stringify({ event_id: eventId }),
  ]);
}

export async function alarmRoute(req: any, res: any) {
  try {
    if (alarmsDisabled()) {
      return res.json({
        ok: true,
        suppressed: true,
        reason: 'alerts_disabled',
        delivered: false,
        delivery_error: null,
      });
    }

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

    if (fromBot.includes('cross_team_router') && team === 'blog') {
      const lunaReq = _parseLunaBlogRequest(message);
      if (lunaReq) {
        _insertLunaBlogRequest(lunaReq.regime, lunaReq.mood, lunaReq.keywordHints, eventId).catch((err: any) => {
          console.warn('[허브/알람] luna→blog content_request 삽입 실패 (무시):', err?.message);
        });
      }
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
