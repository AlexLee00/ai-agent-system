// @ts-nocheck
'use strict';

const { publishToWebhook } = require('../reporting-hub');

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
    const result = await publishToWebhook({
      event: {
        from_bot: fromBot,
        team: topicTeam || team,
        event_type: eventType,
        alert_level: alertLevel,
        message: enrichedMessage,
        payload: payload || undefined,
        criticalTelegramMode,
      },
    });
    return Boolean(result.ok);
  };
}

module.exports = {
  createEventReporter,
};
