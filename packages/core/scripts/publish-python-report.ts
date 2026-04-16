// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const env = require('../lib/env');

const {
  buildEventPayload,
  normalizeEvent,
  buildReportEvent,
  renderReportEvent,
} = require('../lib/reporting-hub');
const { postAlarm } = require('../lib/openclaw-client');

const TEAM_TOPIC = {
  general: 'general',
  reservation: 'ska',
  ska: 'ska',
  investment: 'luna',
  luna: 'luna',
  claude: 'claude_lead',
  'claude-lead': 'claude_lead',
  blog: 'blog',
  worker: 'worker',
  video: 'video',
  darwin: 'darwin',
  justin: 'justin',
  sigma: 'sigma',
  meeting: 'meeting',
  emergency: 'emergency',
};

function loadStoreSecrets() {
  try {
    const raw = fs.readFileSync(path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function postAlarmViaCurl({ message, team, fromBot, alertLevel }) {
  const store = loadStoreSecrets();
  const token = store?.openclaw?.hooks_token || '';
  const groupId = store?.telegram?.group_id || '';
  const topicIds = store?.telegram?.topic_ids || {};
  const normalizedTeam = TEAM_TOPIC[team] || 'general';
  const topicId = topicIds?.[normalizedTeam] || topicIds?.general || null;
  const to = groupId ? (topicId ? `${groupId}:topic:${topicId}` : groupId) : undefined;
  if (!token || !to) return { ok: false, error: 'missing_hook_secret_or_topic' };

  const prefix = alertLevel >= 3 ? `🚨 [긴급 alert_level=${alertLevel}] ` : '';
  const payload = {
    message: `${prefix}[${fromBot}→${team}] ${message}`,
    name: fromBot,
    agentId: 'main',
    deliver: true,
    channel: 'telegram',
    to,
    wakeMode: 'now',
    timeoutSeconds: 30,
  };

  const result = spawnSync('curl', [
    '-sS',
    '-X', 'POST',
    'http://127.0.0.1:18789/hooks/agent',
    '-H', 'Content-Type: application/json',
    '-H', `Authorization: Bearer ${token}`,
    '--data', JSON.stringify(payload),
  ], {
    encoding: 'utf8',
    timeout: 30000,
  });

  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) {
    return { ok: false, error: result.stderr?.trim() || `curl_exit_${result.status}` };
  }

  try {
    const parsed = JSON.parse(result.stdout || '{}');
    return { ok: parsed.ok === true, body: parsed };
  } catch {
    return { ok: false, error: 'invalid_curl_response' };
  }
}

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

  const results = await postAlarm({
    message: reportMessage,
    team: topicTeam || team,
    alertLevel,
    fromBot,
    payload: event.payload,
  });

  if (!results.ok) {
    const fallback = postAlarmViaCurl({
      message: reportMessage,
      team: topicTeam || team,
      fromBot,
      alertLevel,
    });
    if (fallback.ok) {
      console.log('[python-report] ✅ curl hook 폴백 발행 완료');
      return;
    }
    console.error(`[python-report] ⚠️ postAlarm 발행 실패: ${results.error || results.status || 'unknown'}`);
    console.error(`[python-report] ⚠️ curl hook 폴백 실패: ${fallback.error || 'unknown'}`);
    process.exit(1);
  }

  console.log('[python-report] ✅ postAlarm 발행 완료');
}

main().catch((error) => {
  console.error(`[python-report] ⚠️ 발행 오류: ${error.message}`);
  process.exit(1);
});
