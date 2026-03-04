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

const path     = require('path');
const os       = require('os');
const fs       = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(os.homedir(), '.openclaw', 'workspace', 'claude-team.db');

let _db = null;
function getDb() {
  if (_db) return _db;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  return _db;
}

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
 * @param {number} alertLevel  1~4
 * @returns {boolean} true = 보류(morning_queue), false = 즉시 발송
 */
function shouldDefer(alertLevel) {
  if (!isNightTime()) return false;
  return alertLevel <= 2; // LOW, MEDIUM만 보류
}

/**
 * morning_queue에 보류 등록
 * @param {number} queueId   mainbot_queue.id
 * @param {string} summary   배치 요약 메시지
 * @param {string[]} bots    관련 봇 목록
 */
function deferToMorning(queueId, summary, bots = []) {
  getDb().prepare(`
    INSERT INTO morning_queue (queue_id, summary, bot_list)
    VALUES (?, ?, ?)
  `).run(queueId, summary, JSON.stringify(bots));
}

/**
 * morning_queue에서 미발송 항목 조회 및 마킹
 * @returns {object[]} 보류 항목 목록
 */
function flushMorningQueue() {
  const rows = getDb().prepare(`
    SELECT * FROM morning_queue WHERE sent_at IS NULL ORDER BY deferred_at ASC
  `).all();

  if (rows.length === 0) return [];

  // 발송 처리 마킹
  const now = new Date().toISOString();
  const ids = rows.map(r => r.id);
  getDb().prepare(`
    UPDATE morning_queue SET sent_at = ? WHERE id IN (${ids.map(() => '?').join(',')})
  `).run(now, ...ids);

  return rows;
}

/**
 * 아침 브리핑 메시지 생성
 * @param {object[]} items flushMorningQueue() 결과
 */
function buildMorningBriefing(items) {
  if (items.length === 0) return null;

  // 봇별 그룹핑
  const byBot = {};
  for (const item of items) {
    let bots;
    try { bots = JSON.parse(item.bot_list); } catch { bots = ['알 수 없음']; }
    for (const bot of bots) {
      if (!byBot[bot]) byBot[bot] = [];
      byBot[bot].push(item.summary);
    }
  }

  const lines = [
    `🌅 야간 알람 브리핑 (총 ${items.length}건)`,
    ``,
  ];

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
 * @param {number} lastBriefHour  마지막 브리핑 시각 (KST hour)
 */
function isBriefingTime(lastBriefHour) {
  const h = getKSTHour();
  return h === 8 && lastBriefHour !== 8;
}

module.exports = { isNightTime, shouldDefer, deferToMorning, flushMorningQueue, buildMorningBriefing, isBriefingTime };
