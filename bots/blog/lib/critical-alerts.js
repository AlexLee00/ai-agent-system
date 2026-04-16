'use strict';

const os = require('os');
const path = require('path');
const { updateCriticalIncidentCache } = require('../../../packages/core/lib/critical-incident.legacy');

const ALERT_DEDUPE_PATH = path.join(os.tmpdir(), 'blog-alert-dedupe.json');
const ALERT_DEDUPE_WINDOW_MS = 15 * 60 * 1000;

function classifyReason(message) {
  const compact = String(message || '').replace(/\s+/g, ' ').trim();
  if (/drawthings api 연결 거부|drawthings api 응답 없음|drawthings api 응답 비정상/i.test(compact)) {
    return 'drawthings_unhealthy';
  }
  if (/포트 3100 연결 거부|응답 없음 \(3000ms 타임아웃\)|json 파싱 실패/i.test(compact)) {
    return 'node_server_unhealthy';
  }
  if (/n8n healthz 정상/i.test(compact)) {
    return 'n8n_ok';
  }
  if (/포트 5678 연결 거부|n8n healthz/i.test(compact)) {
    return 'n8n_unhealthy';
  }
  if (/미로드/i.test(compact)) {
    return 'launchd_unloaded';
  }
  if (/비정상 종료/i.test(compact)) {
    return 'abnormal_exit';
  }
  const reasonMatch = compact.match(/(?:사유|reason):\s*(.+)$/i);
  const reason = reasonMatch ? reasonMatch[1].trim() : compact;
  return reason
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9가-힣_:-]/g, '')
    .slice(0, 80) || 'unknown';
}

function normalizeAlertSignature({ event_type, alert_level, message }) {
  if (alert_level == null || alert_level < 3) return null;
  if (event_type !== 'blog_health_check') return null;
  return `blog|${event_type}|${classifyReason(message)}`;
}

function updateIncidentCache(signature, message) {
  return updateCriticalIncidentCache({
    cachePath: ALERT_DEDUPE_PATH,
    signature,
    message,
    latestReason: classifyReason(message),
    windowMs: ALERT_DEDUPE_WINDOW_MS,
    logPrefix: 'blog-alerts',
  });
}

function canonicalizeBlogCriticalAlert({ event_type, alert_level, message }) {
  const signature = normalizeAlertSignature({ event_type, alert_level, message });
  const state = updateIncidentCache(signature, message);
  if (state.suppress) {
    console.log(`[blog-alerts] duplicate suppressed: ${signature} (#${state.incident?.count || 1})`);
  }
  return {
    signature,
    suppress: state.suppress,
    incident: state.incident,
  };
}

function appendIncidentLine(message, signature, incident) {
  if (!signature || !incident) return message;
  if (String(message || '').includes('incident: canonical=1 ')) return message;
  return `${message}\nincident: canonical=1 count=${incident.count} first_seen=${incident.first_seen_at} last_seen=${incident.last_seen_at} reason=${incident.latest_reason}`;
}

module.exports = {
  canonicalizeBlogCriticalAlert,
  appendIncidentLine,
};
