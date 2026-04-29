'use strict';

const sender = require('../../../packages/core/lib/telegram-sender');
const {
  appendIncidentEvent,
  hasIncidentEvent,
} = require('./jay-incident-store');

const sentDedupe = new Map();
const MEETING_PHASES = new Set(['frame', 'plan', 'review', 'test', 'ship', 'reflect', 'final']);

function normalizeText(value, fallback = '') {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function parseBoolean(value, fallback = false) {
  const text = normalizeText(value, fallback ? 'true' : 'false').toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(text);
}

function warnNonBlocking(scope, error, meta = {}) {
  const details = Object.entries(meta)
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => `${key}=${String(value).slice(0, 180)}`)
    .join(' ');
  const suffix = details ? ` (${details})` : '';
  console.warn(`[jay-meeting-reporter] ${scope} failed${suffix}: ${error?.message || error}`);
}

function nowMs() {
  return Date.now();
}

function trimDedupe(ttlMs) {
  const threshold = nowMs() - ttlMs;
  for (const [key, ts] of sentDedupe.entries()) {
    if (ts < threshold) sentDedupe.delete(key);
  }
}

function allowMeetingPhase(phase) {
  const normalized = normalizeText(phase, '').toLowerCase();
  return MEETING_PHASES.has(normalized);
}

function phaseLabel(phase) {
  const labels = {
    frame: '문제정의',
    plan: '계획',
    review: '팀검토',
    test: '검증',
    ship: '적용',
    reflect: '회고',
    final: '완료',
  };
  return labels[phase] || phase;
}

function compactSummary(summary, maxLength = 650) {
  const text = normalizeText(summary, '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 20)).trim()} ... (truncated)`;
}

function buildMeetingMessage(input) {
  const incidentKey = normalizeText(input?.incidentKey, 'unknown_incident');
  const phase = normalizeText(input?.phase, 'plan').toLowerCase();
  const team = normalizeText(input?.team, 'general');
  const title = normalizeText(input?.title, `${team} orchestration update`);
  const summary = compactSummary(input?.summary);
  const lines = [
    `🧭 [Jay 회의] ${phase.toUpperCase()} · ${phaseLabel(phase)} · ${team}`,
    `제목: ${title}`,
    `incident: ${incidentKey}`,
  ];
  if (summary) lines.push(`요약: ${summary}`);
  return lines.join('\n');
}

async function publishMeetingSummary(input) {
  if (!parseBoolean(process.env.JAY_3TIER_TELEGRAM, false)) {
    return { ok: true, skipped: true, reason: 'jay_3tier_telegram_disabled' };
  }
  const phase = normalizeText(input?.phase, 'plan').toLowerCase();
  if (!allowMeetingPhase(phase)) {
    return { ok: true, skipped: true, reason: 'phase_not_summary_level' };
  }

  const ttlMs = Math.max(60_000, Number(process.env.JAY_MEETING_DEDUPE_TTL_MS || 900_000) || 900_000);
  trimDedupe(ttlMs);
  const dedupeKey = normalizeText(input?.dedupeKey, `${normalizeText(input?.incidentKey, 'unknown')}|${phase}|${normalizeText(input?.team, 'general')}`);
  if (sentDedupe.has(dedupeKey)) {
    return { ok: true, skipped: true, reason: 'dedupe' };
  }
  const eventType = `telegram_meeting_${phase}`;
  const incidentKey = normalizeText(input?.incidentKey, '');
  if (incidentKey && incidentKey !== 'unknown') {
    const alreadySent = await hasIncidentEvent({ incidentKey, eventType }).catch((error) => {
      warnNonBlocking('persistent_dedupe_check', error, { incidentKey, eventType });
      return false;
    });
    if (alreadySent) {
      sentDedupe.set(dedupeKey, nowMs());
      return { ok: true, skipped: true, reason: 'persistent_dedupe' };
    }
  }

  const text = buildMeetingMessage(input);
  const sent = await sender.sendBuffered('meeting', text);
  if (!sent) {
    return { ok: false, error: 'meeting_topic_send_failed', dedupeKey };
  }
  sentDedupe.set(dedupeKey, nowMs());
  if (incidentKey && incidentKey !== 'unknown') {
    await appendIncidentEvent({
      incidentKey,
      eventType,
      payload: {
        team: normalizeText(input?.team, 'general'),
        phase,
        dedupeKey,
      },
    }).catch((error) => warnNonBlocking('append_meeting_event', error, { incidentKey, eventType }));
  }
  return { ok: true, sent: true, dedupeKey, phase };
}

async function publishTeamProgress(input) {
  if (!parseBoolean(process.env.JAY_3TIER_TELEGRAM, false)) {
    return { ok: true, skipped: true, reason: 'jay_3tier_telegram_disabled' };
  }
  const team = normalizeText(input?.team, 'general').toLowerCase();
  const incidentKey = normalizeText(input?.incidentKey, 'unknown_incident');
  const status = normalizeText(input?.status, 'running');
  const message = normalizeText(input?.message, '');
  const lines = [
    `🤝 [Jay→${team}] ${status}`,
    `incident: ${incidentKey}`,
  ];
  if (message) lines.push(message);
  const sent = await sender.sendBuffered(team, lines.join('\n'));
  return sent ? { ok: true, sent: true } : { ok: false, error: 'team_topic_send_failed' };
}

module.exports = {
  publishMeetingSummary,
  publishTeamProgress,
  _testOnly: {
    allowMeetingPhase,
    buildMeetingMessage,
    compactSummary,
    MEETING_PHASES,
  },
};
