'use strict';

/**
 * lib/mainbot-client.js — 클로드팀 → 텔레그램 알람 발행 클라이언트 (CJS)
 *
 * telegram-sender.js 경유로 🔧 클로드 Forum Topic에 직접 발송.
 * alert_level >= 3 (HIGH/CRITICAL) 은 🚨 긴급 + 🔧 클로드 이중 발송.
 */

const sender = require('../../../packages/core/lib/telegram-sender');
const { publishToTelegram } = require('../../../packages/core/lib/reporting-hub');

/**
 * 클로드팀 알람 발행 → 텔레그램 Forum Topic 직접 라우팅
 * @param {object} opts
 * @param {string} opts.from_bot     발신 봇 ID (dexter, archer)
 * @param {string} [opts.team]       팀명 (기본: claude)
 * @param {string} opts.event_type   이벤트 유형 (system|report|alert)
 * @param {number} [opts.alert_level] 1~4 (기본: 2=MEDIUM, 3+=CRITICAL 이중 발송)
 * @param {string} opts.message      사람이 읽는 메시지
 * @param {object} [opts.payload]    JSON 구조화 데이터 (무시됨 — 로그 호환용)
 */
async function publishToMainBot({ from_bot, team = 'claude', event_type, alert_level = 2, message, payload }) {
  const topicTeam = team === 'claude' ? 'claude-lead' : team;
  const result = await publishToTelegram({
    sender,
    topicTeam,
    event: { from_bot, team, event_type, alert_level, message, payload },
    policy: {
      cooldownMs: alert_level >= 3 ? 60_000 : 5 * 60_000,
      quietHours: {
        timezone: 'KST',
        startHour: 23,
        endHour: 8,
        maxAlertLevel: 1,
      },
    },
  });
  return result.ok;
}

module.exports = { publishToMainBot };
