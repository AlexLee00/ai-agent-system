'use strict';

/**
 * lib/mainbot-client.js — 클로드팀 알람 발행 클라이언트 (CJS)
 *
 * OpenClaw webhook 경유로 전달하고, 실패 시 queue/n8n 정책에 따른다.
 */

const { postAlarm } = require('../../../packages/core/lib/openclaw-client');

/**
 * 클로드팀 알람 발행 → OpenClaw webhook 우선
 * @param {object} opts
 * @param {string} opts.from_bot     발신 봇 ID (dexter, archer)
 * @param {string} [opts.team]       팀명 (기본: claude)
 * @param {string} opts.event_type   이벤트 유형 (system|report|alert)
 * @param {number} [opts.alert_level] 1~4 (기본: 2=MEDIUM, 3+=CRITICAL 이중 발송)
 * @param {string} opts.message      사람이 읽는 메시지
 * @param {object} [opts.payload]    JSON 구조화 데이터 (무시됨 — 로그 호환용)
 */
async function publishToMainBot({ from_bot, team = 'claude', event_type, alert_level = 2, message, payload }) {
  const result = await postAlarm({
    message,
    team,
    alertLevel: alert_level,
    fromBot: from_bot || event_type || 'claude',
  });
  return result.ok;
}

const publishAlert = publishToMainBot;

module.exports = { publishAlert, publishToMainBot };
