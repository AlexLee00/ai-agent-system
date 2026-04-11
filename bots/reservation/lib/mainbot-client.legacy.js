'use strict';

/**
 * lib/mainbot-client.js — 스카팀 → 메인봇 알람 발행 클라이언트 (CJS)
 *
 * OpenClaw webhook 단일 경로만 사용한다.
 */
const { postAlarm } = require('../../../packages/core/lib/openclaw-client');
const { tryTelegramSend } = require('./telegram');

/**
 * OpenClaw webhook으로 알람 발행
 * @param {object} opts
 * @param {string} opts.from_bot     발신 봇 ID (ska, andy, jimmy, rebecca, eve)
 * @param {string} [opts.team]       팀명 (기본: reservation)
 * @param {string} opts.event_type   이벤트 유형 (monitor|alert|system|report)
 * @param {number} [opts.alert_level] 1~4 (기본: 2=MEDIUM)
 * @param {string} opts.message      사람이 읽는 메시지
 * @param {object} [opts.payload]    JSON 구조화 데이터
 */
async function publishToMainBot({ from_bot, team = 'reservation', event_type, alert_level = 2, message, payload }) {
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
  if (result.ok) return true;

  // Heartbeat는 개인 채팅 fallback을 타지 않게 해서 불필요한 DM 소음을 막는다.
  if (event_type === 'heartbeat') return false;

  // OpenClaw/Hook 경로 장애 시 스카 예약 알림은 텔레그램 직접 발송으로 한 번 더 시도한다.
  return tryTelegramSend(lines.filter(Boolean).join('\n'));
}

module.exports = { publishToMainBot };
