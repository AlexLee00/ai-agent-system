'use strict';

const { postAlarm } = require('../openclaw-client');

/**
 * @param {{
 *   fromBot: string,
 *   team: string,
 *   topicTeam?: string,
 *   defaultEventType?: string,
 *   defaultAlertLevel?: number,
 *   defaultCooldownMs?: number,
 *   quietHours?: any,
 *   includeQueue?: boolean,
 *   includeTelegram?: boolean,
 *   includeN8n?: boolean
 * }} input
 */
function createEventReporter({
  fromBot,
  team,
  topicTeam,
  defaultEventType = 'report',
  defaultAlertLevel = 1,
}) {
  return async function publishTeamMessage({
    message,
    eventType = defaultEventType,
    alertLevel = defaultAlertLevel,
    payload = null,
    criticalTelegramMode = undefined,
  }) {
    const enrichedMessage = payload
      ? `${message}\n\nevent_type: ${eventType}`
      : message;
    const result = await postAlarm(/** @type {any} */ ({
      message: enrichedMessage,
      team: topicTeam || team,
      alertLevel,
      fromBot,
      payload: payload || undefined,
      criticalTelegramMode,
    }));
    return result.ok;
  };
}

module.exports = {
  createEventReporter,
};
