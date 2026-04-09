'use strict';

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
} = require('../../../packages/core/lib/reporting-hub') as {
  buildNoticeEvent: (event: Record<string, unknown>) => unknown;
  renderNoticeEvent: (event: unknown) => string;
  buildSnippetEvent: (event: Record<string, unknown>) => unknown;
  renderSnippetEvent: (event: unknown) => string;
  parseEventPayload: (payload: unknown) => Record<string, unknown> | null;
  getEventHeadline: (item: QueueItem) => string;
  getEventDetailLines: (item: QueueItem) => string[];
  getEventAction: (item: QueueItem) => string | null;
  getEventLinkLines: (item: QueueItem) => string[];
};

type QueueItem = {
  from_bot?: string;
  team?: string;
  event_type?: string;
  alert_level?: number;
  payload?: unknown;
};

type Delivery = {
  text: string;
  replyMarkup: {
    inline_keyboard: Array<Array<{ text: string; url: string }>>;
  } | null;
  team: string;
};

const ALERT_ICONS: Record<number, string> = { 1: 'ℹ️', 2: '⚠️', 3: '🟠', 4: '🚨' };

function formatSingle(item: QueueItem): string {
  const headline = getEventHeadline(item);
  const action = getEventAction(item) || '상세 내용 확인';
  const linkLines = getEventLinkLines(item);
  const title = headline || `${item.from_bot} 알림`;
  const summary = headline ? '' : item.event_type || '';
  return renderNoticeEvent(
    buildNoticeEvent({
      from_bot: item.from_bot,
      team: item.team,
      event_type: item.event_type,
      alert_level: item.alert_level,
      title,
      summary,
      details: [...getEventDetailLines(item), ...linkLines],
      action,
      footer: '추가 점검: /ops-health',
    })
  );
}

function buildSingleDelivery(item: QueueItem): Delivery {
  const payload = parseEventPayload(item?.payload);
  const links = Array.isArray(payload?.links)
    ? payload.links
        .map((link) => ({
          label: String((link as { label?: unknown })?.label || '').trim(),
          href: String((link as { href?: unknown })?.href || '').trim(),
        }))
        .filter((link) => link.label && link.href)
        .slice(0, 2)
    : [];

  const replyMarkup =
    links.length > 0
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
    team: item?.team || 'general',
  };
}

function formatBatch(botName: string, items: QueueItem[]): string {
  if (items.length === 1) {
    return formatSingle(items[0]);
  }

  const maxLevel = Math.max(...items.map((item) => item.alert_level || 0));
  const icon = ALERT_ICONS[maxLevel] || '⚪';
  const eventTypes = [...new Set(items.map((item) => item.event_type))].join(', ');
  const lines = items.slice(0, 5).map((item) => {
    const levelIcon = ALERT_ICONS[item.alert_level || 0] || '•';
    return `${levelIcon} ${getEventHeadline(item).slice(0, 80)}`;
  });
  const actions = [...new Set(items.map((item) => getEventAction(item)).filter(Boolean))];
  const links = [
    ...new Set(items.flatMap((item) => getEventLinkLines(item)).filter(Boolean)),
  ] as string[];

  if (items.length > 5) {
    lines.push(`... 외 ${items.length - 5}건`);
  }
  if (actions.length > 0) {
    lines.push(`조치: ${actions.slice(0, 2).join(' | ')}`);
  }
  if (links.length > 0) {
    lines.push(`참고: ${links.slice(0, 2).join(' | ')}`);
  }

  return renderSnippetEvent(
    buildSnippetEvent({
      from_bot: botName,
      team: items[0]?.team || 'general',
      event_type: 'batch_alert',
      alert_level: maxLevel,
      title: `${icon} ${botName} 집약 알림`,
      lines: [`건수: ${items.length}건`, `유형: ${eventTypes}`, ...lines],
    })
  );
}

function formatMultiBot(items: QueueItem[]): string | null {
  if (items.length === 0) {
    return null;
  }
  if (items.length === 1) {
    return formatSingle(items[0]);
  }

  const byBot: Record<string, QueueItem[]> = {};
  for (const item of items) {
    const bot = item.from_bot || 'unknown';
    if (!byBot[bot]) {
      byBot[bot] = [];
    }
    byBot[bot].push(item);
  }

  const maxLevel = Math.max(...items.map((item) => item.alert_level || 0));
  const icon = ALERT_ICONS[maxLevel] || '⚪';
  const botCount = Object.keys(byBot).length;
  const lines = [`봇 수: ${botCount}개`, `총 건수: ${items.length}건`];

  for (const [bot, botItems] of Object.entries(byBot)) {
    lines.push(`【${bot}】 ${botItems.length}건`);
    for (const item of botItems.slice(0, 2)) {
      lines.push(`• ${getEventHeadline(item).slice(0, 60)}`);
    }
    const botActions = [
      ...new Set(botItems.map((item) => getEventAction(item)).filter(Boolean)),
    ];
    if (botActions.length > 0) {
      lines.push(`• 조치: ${botActions[0]}`);
    }
    if (botItems.length > 2) {
      lines.push('• ...');
    }
  }

  return renderSnippetEvent(
    buildSnippetEvent({
      from_bot: 'mainbot',
      team: 'system',
      event_type: 'multi_bot_alert',
      alert_level: maxLevel,
      title: `${icon} 통합 알림 집약`,
      lines,
    })
  );
}

function eventSummary(eventType: string, count: number): string {
  const labels: Record<string, string> = {
    trade: `거래 신호 ${count}건`,
    alert: `알람 ${count}건`,
    system: `시스템 이벤트 ${count}건`,
    report: `리포트 ${count}건`,
    monitor: `모니터링 ${count}건`,
  };
  return labels[eventType] || `${eventType} ${count}건`;
}

module.exports = {
  buildSingleDelivery,
  eventSummary,
  formatBatch,
  formatMultiBot,
  formatSingle,
};
