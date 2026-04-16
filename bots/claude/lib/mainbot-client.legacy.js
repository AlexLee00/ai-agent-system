'use strict';

/**
 * lib/mainbot-client.js — 클로드팀 알람 발행 클라이언트 (CJS)
 *
 * OpenClaw webhook 경유로 전달하고, 실패 시 queue/n8n 정책에 따른다.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { postAlarm } = require('../../../packages/core/lib/openclaw-client');

const ALERT_DEDUPE_PATH = path.join(os.tmpdir(), 'claude-alert-dedupe.json');
const ALERT_DEDUPE_WINDOW_MS = 15 * 60 * 1000;

function classifyReason(message) {
  const compact = String(message || '').replace(/\s+/g, ' ').trim();
  const reasonMatch = compact.match(/(?:사유|reason):\s*(.+)$/i);
  const reason = reasonMatch ? reasonMatch[1].trim() : compact;
  return reason
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9가-힣_:-]/g, '')
    .slice(0, 80) || 'unknown';
}

function normalizeAlertSignature({ team, event_type, alert_level, message }) {
  if (alert_level == null || alert_level < 3) return null;
  if (!['system_error', 'health_check'].includes(event_type)) return null;
  return `${team || 'claude'}|${event_type}|${classifyReason(message)}`;
}

function updateIncidentCache(signature, message) {
  if (!signature) return { suppress: false, incident: null };

  try {
    fs.mkdirSync(path.dirname(ALERT_DEDUPE_PATH), { recursive: true });
    let cache = {};

    if (fs.existsSync(ALERT_DEDUPE_PATH)) {
      cache = JSON.parse(fs.readFileSync(ALERT_DEDUPE_PATH, 'utf8') || '{}');
    }

    const now = Date.now();
    const latestReason = classifyReason(message);
    const recent = cache[signature];
    cache = Object.fromEntries(
      Object.entries(cache).filter(([, incident]) => now - Number(incident?.last_seen_at || 0) < ALERT_DEDUPE_WINDOW_MS)
    );

    if (recent && now - Number(recent.last_seen_at || 0) < ALERT_DEDUPE_WINDOW_MS) {
      cache[signature] = {
        ...recent,
        count: Number(recent.count || 0) + 1,
        last_seen_at: now,
        latest_message: message,
        latest_reason: latestReason,
      };
      fs.writeFileSync(ALERT_DEDUPE_PATH, JSON.stringify(cache, null, 2));
      return {
        suppress: true,
        incident: {
          count: cache[signature].count,
          first_seen_at: new Date(cache[signature].first_seen_at).toISOString(),
          last_seen_at: new Date(cache[signature].last_seen_at).toISOString(),
          latest_reason: cache[signature].latest_reason,
        },
      };
    }

    cache[signature] = {
      count: 1,
      first_seen_at: now,
      last_seen_at: now,
      latest_message: message,
      latest_reason: latestReason,
    };
    fs.writeFileSync(ALERT_DEDUPE_PATH, JSON.stringify(cache, null, 2));
  } catch (error) {
    console.warn(`[claude-alert] dedupe cache 실패: ${String(error?.message || error)}`);
  }

  return {
    suppress: false,
    incident: {
      count: 1,
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      latest_reason: classifyReason(message),
    },
  };
}

/**
 * 클로드팀 알람 발행 → OpenClaw webhook 우선
 * @param {object} opts
 * @param {string} opts.from_bot     발신 봇 ID (dexter, archer)
 * @param {string} [opts.team]       팀명 (기본: claude)
 * @param {string} opts.event_type   이벤트 유형 (system|report|alert)
 * @param {number} [opts.alert_level] 1~4 (기본: 2=MEDIUM, 3+=CRITICAL 이중 발송)
 * @param {string} opts.message      사람이 읽는 메시지
 * @param {object} [opts.payload]    JSON 구조화 데이터 (무시됨 — 로그 호환용)
 */
async function publishToMainBot({ from_bot, team = 'claude', event_type, alert_level = 2, message, payload }) {
  const signature = normalizeAlertSignature({ team, event_type, alert_level, message });
  const incidentState = updateIncidentCache(signature, message);
  if (incidentState.suppress) {
    console.log(`[claude-alert] duplicate suppressed: ${signature} (#${incidentState.incident?.count || 1})`);
    return true;
  }

  const lines = [message];
  if (incidentState.incident && signature) {
    lines.push(
      `incident: canonical=1 count=${incidentState.incident.count} first_seen=${incidentState.incident.first_seen_at} last_seen=${incidentState.incident.last_seen_at} reason=${incidentState.incident.latest_reason}`
    );
  }
  if (payload && typeof payload === 'object') {
    lines.push(`payload: ${JSON.stringify(payload)}`);
  }
  if (event_type) {
    lines.push(`event_type: ${event_type}`);
  }

  const result = await postAlarm({
    message: lines.filter(Boolean).join('\n'),
    team,
    alertLevel: alert_level,
    fromBot: from_bot || event_type || 'claude',
  });
  return result.ok;
}

const publishAlert = publishToMainBot;

module.exports = { publishAlert, publishToMainBot };
