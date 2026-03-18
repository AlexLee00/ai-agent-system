'use strict';

/**
 * lib/batch-formatter.js — 템플릿 기반 배치 요약 (LLM 0토큰)
 *
 * 동일 봇에서 짧은 시간 내 여러 알람이 오면 하나로 묶어서 발송.
 * LLM 없이 템플릿으로만 처리.
 */

const {
  buildNoticeEvent,
  renderNoticeEvent,
  buildSnippetEvent,
  renderSnippetEvent,
  parseEventPayload,
  getEventHeadline,
  getEventDetailLines,
  getEventAction,
  getEventLinkLines,
} = require('../../../packages/core/lib/reporting-hub');

const ALERT_ICONS = { 1: 'ℹ️', 2: '⚠️', 3: '🟠', 4: '🚨' };
const ALERT_LABELS = { 1: '안내', 2: '경고', 3: '높음', 4: '긴급 장애' };

/**
 * 단일 알람 포맷
 * @param {object} item mainbot_queue 행
 */
function formatSingle(item) {
  const icon   = ALERT_ICONS[item.alert_level] || '⚪';
  const label  = ALERT_LABELS[item.alert_level] || '?';
  const headline = getEventHeadline(item);
  const action = getEventAction(item) || '상세 내용 확인';
  const linkLines = getEventLinkLines(item);
  return renderNoticeEvent(buildNoticeEvent({
    from_bot: item.from_bot,
    team: item.team,
    event_type: item.event_type,
    alert_level: item.alert_level,
    title: `${icon} ${item.from_bot} 알림`,
    summary: headline ? `${label} · ${headline}` : `${label} · ${item.event_type}`,
    details: [...getEventDetailLines(item), ...linkLines],
    action,
    footer: '추가 점검: /ops-health',
  }));
}

function buildSingleDelivery(item) {
  const payload = parseEventPayload(item?.payload);
  const links = Array.isArray(payload?.links)
    ? payload.links
      .map((link) => ({
        label: String(link?.label || '').trim(),
        href: String(link?.href || '').trim(),
      }))
      .filter((link) => link.label && link.href)
      .slice(0, 2)
    : [];

  const replyMarkup = links.length > 0
    ? {
      inline_keyboard: [
        links.map((link) => ({
          text: link.label.slice(0, 32),
          url: link.href,
        })),
      ],
    }
    : null;

  return {
    text: formatSingle(item),
    replyMarkup,
  };
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
  const lines = items.slice(0, 5).map((item) => {
    const lvl = ALERT_ICONS[item.alert_level] || '•';
    return `${lvl} ${getEventHeadline(item).slice(0, 80)}`;
  });
  const actions = [...new Set(items.map((item) => getEventAction(item)).filter(Boolean))];
  const links = [...new Set(items.flatMap((item) => getEventLinkLines(item)).filter(Boolean))];
  if (items.length > 5) lines.push(`... 외 ${items.length - 5}건`);
  if (actions.length > 0) lines.push(`조치: ${actions.slice(0, 2).join(' | ')}`);
  if (links.length > 0) lines.push(`참고: ${links.slice(0, 2).join(' | ')}`);

  return renderSnippetEvent(buildSnippetEvent({
    from_bot: botName,
    team: items[0]?.team || 'general',
    event_type: 'batch_alert',
    alert_level: maxLevel,
    title: `${icon} ${botName} 집약 알림`,
    lines: [
      `건수: ${items.length}건`,
      `유형: ${eventTypes}`,
      ...lines,
    ],
  }));
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

  const lines = [
    `봇 수: ${botCount}개`,
    `총 건수: ${items.length}건`,
  ];

  for (const [bot, botItems] of Object.entries(byBot)) {
    lines.push(`【${bot}】 ${botItems.length}건`);
    for (const item of botItems.slice(0, 2)) {
      lines.push(`• ${getEventHeadline(item).slice(0, 60)}`);
    }
    const botActions = [...new Set(botItems.map((item) => getEventAction(item)).filter(Boolean))];
    if (botActions.length > 0) lines.push(`• 조치: ${botActions[0]}`);
    if (botItems.length > 2) lines.push('• ...');
  }

  return renderSnippetEvent(buildSnippetEvent({
    from_bot: 'mainbot',
    team: 'system',
    event_type: 'multi_bot_alert',
    alert_level: maxLevel,
    title: `${icon} 통합 알림 집약`,
    lines,
  }));
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

module.exports = { formatSingle, formatBatch, formatMultiBot, buildSingleDelivery, eventSummary };
