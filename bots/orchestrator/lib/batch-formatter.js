'use strict';

/**
 * lib/batch-formatter.js — 템플릿 기반 배치 요약 (LLM 0토큰)
 *
 * 동일 봇에서 짧은 시간 내 여러 알람이 오면 하나로 묶어서 발송.
 * LLM 없이 템플릿으로만 처리.
 */

const ALERT_ICONS = { 1: '🔵', 2: '🟡', 3: '🟠', 4: '🔴' };
const ALERT_LABELS = { 1: 'LOW', 2: 'MEDIUM', 3: 'HIGH', 4: 'CRITICAL' };

/**
 * 단일 알람 포맷
 * @param {object} item mainbot_queue 행
 */
function formatSingle(item) {
  const icon   = ALERT_ICONS[item.alert_level] || '⚪';
  const label  = ALERT_LABELS[item.alert_level] || '?';
  const botTag = `[${item.from_bot}]`;
  return `${icon} ${label} ${botTag}\n${item.message}`;
}

/**
 * 배치 알람 포맷 (같은 봇 여러 건)
 * @param {string}   botName  봇 이름
 * @param {object[]} items    mainbot_queue 행 배열
 */
function formatBatch(botName, items) {
  if (items.length === 1) return formatSingle(items[0]);

  const maxLevel = Math.max(...items.map(i => i.alert_level));
  const icon     = ALERT_ICONS[maxLevel] || '⚪';
  const eventTypes = [...new Set(items.map(i => i.event_type))].join(', ');

  const lines = [
    `${icon} [${botName}] ${items.length}건 알람 (${eventTypes})`,
    ``,
  ];

  for (const item of items.slice(0, 5)) {
    const lvl = ALERT_ICONS[item.alert_level];
    lines.push(`${lvl} ${item.message.split('\n')[0].slice(0, 80)}`);
  }
  if (items.length > 5) {
    lines.push(`... 외 ${items.length - 5}건`);
  }

  return lines.join('\n');
}

/**
 * 다중 봇 집약 포맷 (여러 팀 알람)
 * @param {object[]} items mainbot_queue 행 배열
 */
function formatMultiBot(items) {
  if (items.length === 0) return null;
  if (items.length === 1) return formatSingle(items[0]);

  // 봇별 그룹핑
  const byBot = {};
  for (const item of items) {
    if (!byBot[item.from_bot]) byBot[item.from_bot] = [];
    byBot[item.from_bot].push(item);
  }

  const maxLevel = Math.max(...items.map(i => i.alert_level));
  const icon     = ALERT_ICONS[maxLevel] || '⚪';
  const botCount = Object.keys(byBot).length;

  const lines = [`${icon} 알람 집약 (${botCount}개 봇, ${items.length}건)`, ``];

  for (const [bot, botItems] of Object.entries(byBot)) {
    lines.push(`【${bot}】 ${botItems.length}건`);
    for (const item of botItems.slice(0, 2)) {
      lines.push(`  • ${item.message.split('\n')[0].slice(0, 60)}`);
    }
    if (botItems.length > 2) lines.push(`  • ...`);
  }

  return lines.join('\n');
}

/**
 * 이벤트 타입별 요약 레이블
 */
function eventSummary(eventType, count) {
  const labels = {
    trade:    `거래 신호 ${count}건`,
    alert:    `알람 ${count}건`,
    system:   `시스템 이벤트 ${count}건`,
    report:   `리포트 ${count}건`,
    monitor:  `모니터링 ${count}건`,
  };
  return labels[eventType] || `${eventType} ${count}건`;
}

module.exports = { formatSingle, formatBatch, formatMultiBot, eventSummary };
