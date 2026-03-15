'use strict';

const fs = require('fs');
const path = require('path');

const sender = require('../lib/telegram-sender');
const {
  buildEventPayload,
  normalizeEvent,
  buildReportEvent,
  renderReportEvent,
  publishEventPipeline,
  buildSeverityTargets,
} = require('../lib/reporting-hub');

function readStdin() {
  return fs.readFileSync(0, 'utf8').trim();
}

function parseArgs() {
  const args = process.argv.slice(2);
  const map = {};
  for (const arg of args) {
    if (!arg.startsWith('--')) continue;
    const [key, value = 'true'] = arg.slice(2).split('=');
    map[key] = value;
  }
  return map;
}

function splitTextSections(text) {
  const lines = text.split('\n').map((line) => line.trimEnd());
  const title = lines.find((line) => line.trim()) || '';
  const bodyLines = lines.filter((line, index) => !(index === 0 && line === title));
  const summary = bodyLines.find((line) => line.trim()) || '';
  const details = bodyLines.filter((line) => line.trim());
  return { title, summary, details };
}

function parseLinks(raw) {
  if (!raw) return [];
  return String(raw)
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [label, href = ''] = part.split('::');
      return {
        label: String(label || '').trim(),
        href: String(href || '').trim(),
      };
    })
    .filter((link) => link.label);
}

async function main() {
  const args = parseArgs();
  const text = readStdin();
  if (!text) {
    console.log('[python-report] ⚠️ 발행할 리포트 없음 — 스킵');
    return;
  }

  const fromBot = args.fromBot || 'python-report';
  const team = args.team || 'reservation';
  const topicTeam = args.topicTeam || 'general';
  const eventType = args.eventType || 'report';
  const titleFallback = args.title || 'Python 리포트';
  const footer = args.footer || '';
  const action = args.action || '';
  const links = parseLinks(args.links);
  const alertLevel = Number.isFinite(Number(args.alertLevel)) ? Number(args.alertLevel) : 1;

  const parsed = splitTextSections(text);
  const title = parsed.title || titleFallback;
  const summary = parsed.summary || titleFallback;
  const event = normalizeEvent({
    from_bot: fromBot,
    team,
    event_type: eventType,
    alert_level: alertLevel,
    message: text,
    payload: buildEventPayload({
      title,
      summary,
      details: parsed.details,
      action,
      links,
    }),
  });

  const reportMessage = renderReportEvent(buildReportEvent({
    from_bot: event.from_bot,
    team: event.team,
    event_type: event.event_type,
    alert_level: event.alert_level,
    title,
    summary,
    sections: [
      { title: '', lines: parsed.details },
    ],
    footer,
    payload: event.payload,
  }));

  const results = await publishEventPipeline({
    event: {
      ...event,
      message: reportMessage,
    },
    policy: {
      cooldownMs: 0,
      dedupe: false,
    },
    targets: buildSeverityTargets({
      event,
      sender,
      topicTeam,
      telegramPrefix: '',
      includeQueue: false,
      includeTelegram: true,
      includeN8n: false,
    }),
  });

  if (!results.ok) {
    console.error('[python-report] ⚠️ reporting-hub 발행 실패');
    process.exit(1);
  }

  console.log('[python-report] ✅ reporting-hub 발행 완료');
}

main().catch((error) => {
  console.error(`[python-report] ⚠️ 발행 오류: ${error.message}`);
  process.exit(1);
});
