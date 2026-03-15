'use strict';

function normalizeEvent({
  from_bot,
  team = 'general',
  event_type = 'report',
  alert_level = 2,
  message = '',
  payload = null,
} = {}) {
  return {
    from_bot: String(from_bot || 'unknown'),
    team: String(team || 'general'),
    event_type: String(event_type || 'report'),
    alert_level: Number.isFinite(Number(alert_level)) ? Number(alert_level) : 2,
    message: String(message || '').trim(),
    payload: payload == null ? null : payload,
  };
}

async function publishToQueue({
  pgPool,
  schema = 'claude',
  table = 'mainbot_queue',
  event,
}) {
  const normalized = normalizeEvent(event);
  try {
    await pgPool.run(schema, `
      INSERT INTO ${table} (from_bot, team, event_type, alert_level, message, payload)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      normalized.from_bot,
      normalized.team,
      normalized.event_type,
      normalized.alert_level,
      normalized.message,
      normalized.payload ? JSON.stringify(normalized.payload) : null,
    ]);
    return { ok: true, channel: 'queue', event: normalized };
  } catch (error) {
    console.warn(`[reporting-hub] queue publish failed: ${error.message}`);
    return { ok: false, channel: 'queue', event: normalized, error: error.message };
  }
}

async function publishToTelegram({
  sender,
  topicTeam,
  event,
  prefix = '',
}) {
  const normalized = normalizeEvent(event);
  const finalMessage = `${prefix || ''}${normalized.message}`.trim();

  try {
    const ok = normalized.alert_level >= 3
      ? await sender.sendCritical(topicTeam, finalMessage)
      : await sender.send(topicTeam, finalMessage);
    return { ok: Boolean(ok), channel: 'telegram', event: normalized };
  } catch (error) {
    console.warn(`[reporting-hub] telegram publish failed: ${error.message}`);
    return { ok: false, channel: 'telegram', event: normalized, error: error.message };
  }
}

module.exports = {
  normalizeEvent,
  publishToQueue,
  publishToTelegram,
};
