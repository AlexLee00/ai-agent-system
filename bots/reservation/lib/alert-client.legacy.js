'use strict';

/**
 * lib/alert-client.js — 스카팀 알람 발행 클라이언트 (CJS)
 *
 * 메인봇 제거 이후 OpenClaw webhook 단일 경로만 사용한다.
 */
const { postAlarm } = require('../../../packages/core/lib/openclaw-client');

async function publishReservationAlert({ from_bot, team = 'reservation', event_type, alert_level = 2, message, payload }) {
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

const publishToMainBot = publishReservationAlert;

module.exports = {
  publishReservationAlert,
  publishToMainBot,
};
