'use strict';

const {
  publishEventPipeline,
  buildSeverityTargets,
} = require('../reporting-hub');

function createEventReporter({
  sender,
  fromBot,
  team,
  topicTeam,
  defaultEventType = 'report',
  defaultAlertLevel = 1,
  defaultCooldownMs = 5 * 60_000,
  quietHours = null,
  includeQueue = false,
  includeTelegram = true,
  includeN8n = true,
  telegramPrefix = null,
}) {
  return async function publishTeamMessage({
    message,
    eventType = defaultEventType,
    alertLevel = defaultAlertLevel,
    payload = null,
    criticalTelegramMode = 'both',
  }) {
    const event = {
      from_bot: fromBot,
      team,
      event_type: eventType,
      alert_level: alertLevel,
      message,
      payload,
    };
    const result = await publishEventPipeline({
      event,
      policy: {
        cooldownMs: alertLevel >= 3 ? 60_000 : defaultCooldownMs,
        ...(quietHours ? { quietHours } : {}),
      },
      targets: buildSeverityTargets({
        event,
        sender,
        topicTeam,
        includeQueue,
        includeTelegram,
        includeN8n,
        criticalTelegramMode,
        ...(telegramPrefix ? { telegramPrefix } : {}),
      }),
    });
    return result.ok;
  };
}

module.exports = {
  createEventReporter,
};
