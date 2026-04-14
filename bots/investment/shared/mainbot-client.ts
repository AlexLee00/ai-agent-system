// @ts-nocheck
/**
 * shared/mainbot-client.js — 루나팀 알람 발행 클라이언트 (ESM)
 *
 * OpenClaw webhook 경유로 전달한다.
 */

import { createRequire } from 'module';

const require  = createRequire(import.meta.url);
const { publishToWebhook } = require('../../../packages/core/lib/reporting-hub');

/**
 * OpenClaw webhook으로 알람 발행
 * @param {object} opts
 * @param {string} opts.from_bot     발신 봇 ID (luna, jason, tyler, molly, chris...)
 * @param {string} [opts.team]       팀명 (기본: investment)
 * @param {string} opts.event_type   이벤트 유형 (trade|alert|system|report)
 * @param {number} [opts.alert_level] 1~4 (기본: 2=MEDIUM)
 * @param {string} opts.message      사람이 읽는 메시지
 * @param {object} [opts.payload]    JSON 구조화 데이터
 */
export async function publishToMainBot({ from_bot, team = 'investment', event_type, alert_level = 2, message, payload }) {
  const event = { from_bot, team, event_type, alert_level, message, payload };

  const webhookResult = await publishToWebhook({
    event,
    policy: {
      cooldownMs: 2 * 60_000,
    },
  });

  if (webhookResult.ok && !webhookResult.skipped) {
    return true;
  }
  console.warn(`[mainbot-client] webhook 실패/스킵: ${webhookResult.error || webhookResult.reason || 'unknown'}`);
  return false;
}

export const publishAlert = publishToMainBot;
