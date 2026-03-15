/**
 * shared/mainbot-client.js — 루나팀 → 메인봇 알람 발행 클라이언트 (ESM)
 *
 * PostgreSQL jay.claude 스키마 mainbot_queue에 INSERT.
 */

import { createRequire } from 'module';

const require  = createRequire(import.meta.url);
const pgPool   = require('../../../packages/core/lib/pg-pool');
const { publishToQueue } = require('../../../packages/core/lib/reporting-hub');

/**
 * 메인봇 큐에 알람 발행
 * @param {object} opts
 * @param {string} opts.from_bot     발신 봇 ID (luna, jason, tyler, molly, chris...)
 * @param {string} [opts.team]       팀명 (기본: investment)
 * @param {string} opts.event_type   이벤트 유형 (trade|alert|system|report)
 * @param {number} [opts.alert_level] 1~4 (기본: 2=MEDIUM)
 * @param {string} opts.message      사람이 읽는 메시지
 * @param {object} [opts.payload]    JSON 구조화 데이터
 */
export async function publishToMainBot({ from_bot, team = 'investment', event_type, alert_level = 2, message, payload }) {
  const result = await publishToQueue({
    pgPool,
    schema: 'claude',
    event: { from_bot, team, event_type, alert_level, message, payload },
  });
  return result.ok;
}
