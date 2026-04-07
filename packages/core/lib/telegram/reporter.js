'use strict';

const { postAlarm } = require('../openclaw-client');

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
  }) {
    const enrichedMessage = payload
      ? `${message}\n\nevent_type: ${eventType}`
      : message;
    const result = await postAlarm({
      message: enrichedMessage,
      team: topicTeam || team,
      alertLevel,
      fromBot,
      payload: payload || undefined,
    });
    return result.ok;
  };
}

module.exports = {
  createEventReporter,
};
