'use strict';

/**
 * lib/night-handler.js — 야간 자율 운영 관리
 *
 * 야간(22:00~08:00 KST):
 *   - MEDIUM(2) 이하 알람 → morning_queue 보류
 *   - HIGH(3) 이상 → 즉시 발송 (단, 배치 요약)
 *   - CRITICAL(4) → 항상 즉시 발송
 *
 * 08:00 KST 아침 브리핑: morning_queue 배치 요약 발송
 */

const pgPool = require('../../../packages/core/lib/pg-pool');

const SCHEMA = 'claude';

// KST 시간 (0~23)
function getKSTHour() {
  return new Date(Date.now() + 9 * 3600 * 1000).getUTCHours();
}

/**
 * 현재 야간 여부
 */
function isNightTime() {
  const h = getKSTHour();
  return h >= 22 || h < 8;
}

/**
 * 야간에 알람을 보류할지 결정
 */
function shouldDefer(alertLevel) {
  if (!isNightTime()) return false;
  return alertLevel <= 2;
}

/**
 * morning_queue에 보류 등록
 */
async function deferToMorning(queueId, summary, bots = []) {
  await pgPool.run(SCHEMA, `
    INSERT INTO morning_queue (queue_id, summary, bot_list)
    VALUES ($1, $2, $3)
  `, [queueId, summary, JSON.stringify(bots)]);
}

/**
 * morning_queue에서 미발송 항목 조회 및 마킹
 */
async function flushMorningQueue() {
  const rows = await pgPool.query(SCHEMA, `
    SELECT * FROM morning_queue WHERE sent_at IS NULL ORDER BY deferred_at ASC
  `);

  if (rows.length === 0) return [];

  const now = new Date().toISOString();
  const ids = rows.map(r => r.id);
  await pgPool.run(SCHEMA, `
    UPDATE morning_queue SET sent_at = $1 WHERE id = ANY($2::int[])
  `, [now, ids]);

  return rows;
}

/**
 * 아침 브리핑 메시지 생성
 */
function buildMorningBriefing(items) {
  if (items.length === 0) return null;

  const byBot = {};
  for (const item of items) {
    let bots;
    try { bots = JSON.parse(item.bot_list); } catch { bots = ['알 수 없음']; }
    for (const bot of bots) {
      if (!byBot[bot]) byBot[bot] = [];
      byBot[bot].push(item.summary);
    }
  }

  const lines = [`🌅 야간 알람 브리핑 (총 ${items.length}건)`, ``];

  for (const [bot, summaries] of Object.entries(byBot)) {
    lines.push(`【${bot}】 ${summaries.length}건`);
    for (const s of summaries.slice(0, 3)) {
      lines.push(`  • ${s}`);
    }
    if (summaries.length > 3) {
      lines.push(`  • ... 외 ${summaries.length - 3}건`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

/**
 * 08:00 KST 기준 브리핑 타이밍인지 확인
 */
function isBriefingTime(lastBriefHour) {
  const h = getKSTHour();
  return h === 8 && lastBriefHour !== 8;
}

module.exports = { isNightTime, shouldDefer, deferToMorning, flushMorningQueue, buildMorningBriefing, isBriefingTime };
