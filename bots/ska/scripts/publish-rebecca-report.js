'use strict';

const fs = require('fs');
const path = require('path');

const sender = require('../../../packages/core/lib/telegram-sender');
const {
  buildEventPayload,
  normalizeEvent,
  buildReportEvent,
  renderReportEvent,
  publishEventPipeline,
  buildSeverityTargets,
} = require('../../../packages/core/lib/reporting-hub');

function readStdin() {
  return fs.readFileSync(0, 'utf8').trim();
}

function parseArgs() {
  const modeArg = process.argv.find((arg) => arg.startsWith('--mode='));
  return {
    mode: modeArg ? modeArg.split('=')[1] : 'daily',
  };
}

function getHeader(mode) {
  return mode === 'weekly'
    ? '레베카 주간 리포트'
    : '레베카 일간 리포트';
}

function splitTextSections(text) {
  const lines = text.split('\n').map((line) => line.trimEnd());
  const title = lines.find((line) => line.trim()) || '';
  const bodyLines = lines.filter((line, index) => !(index === 0 && line === title));
  const summary = bodyLines.find((line) => line.trim()) || '';
  const details = bodyLines.filter((line) => line.trim());
  return { title, summary, details };
}

async function main() {
  const { mode } = parseArgs();
  const text = readStdin();

  if (!text) {
    console.log('[REBECCA] ⚠️ 발행할 리포트 없음 — 스킵');
    return;
  }

  const parsed = splitTextSections(text);
  const title = parsed.title || getHeader(mode);
  const summary = parsed.summary || getHeader(mode);
  const event = normalizeEvent({
    from_bot: 'rebecca',
    team: 'reservation',
    event_type: 'report',
    alert_level: 1,
    message: text,
    payload: buildEventPayload({
      title,
      summary,
      details: parsed.details,
      action: mode === 'weekly'
        ? '상세 확인: /ska-health | /ska-forecast'
        : '상세 확인: /ska-health',
      links: mode === 'weekly'
        ? [
          { label: '스카 헬스', href: '/ska-health' },
          { label: '예측 헬스', href: '/ska-forecast' },
        ]
        : [
          { label: '스카 헬스', href: '/ska-health' },
        ],
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
    footer: mode === 'weekly'
      ? '상세 명령: /ska-health | /ska-forecast'
      : '상세 명령: /ska-health',
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
      topicTeam: 'ska',
      telegramPrefix: '',
      includeQueue: false,
      includeTelegram: true,
      includeN8n: false,
    }),
  });

  if (!results.ok) {
    console.error('[REBECCA] ⚠️ reporting-hub 발행 실패');
    process.exit(1);
  }

  console.log('[REBECCA] ✅ reporting-hub 발행 완료');
}

main().catch((error) => {
  console.error(`[REBECCA] ⚠️ 발행 오류: ${error.message}`);
  process.exit(1);
});
