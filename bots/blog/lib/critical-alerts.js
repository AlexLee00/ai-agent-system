'use strict';

const os = require('os');
const path = require('path');
const { updateCriticalIncidentCache } = require('../../../packages/core/lib/critical-incident.js');

// /tmp는 재부팅 시 초기화되므로 AI_AGENT_WORKSPACE(영속 디렉터리)를 사용한다.
// health-state-manager.ts와 동일한 경로 전략을 따른다.
const _AI_AGENT_HOME = process.env.AI_AGENT_HOME
  || process.env.JAY_HOME
  || path.join(os.homedir(), '.ai-agent-system');
const _AI_AGENT_WORKSPACE = process.env.AI_AGENT_WORKSPACE
  || process.env.JAY_WORKSPACE
  || path.join(_AI_AGENT_HOME, 'workspace');
const ALERT_DEDUPE_PATH = path.join(_AI_AGENT_WORKSPACE, 'blog-alert-dedupe.json');
const ALERT_DEDUPE_WINDOW_MS = 15 * 60 * 1000;
// 지속성 상태(데이터 이슈, 코드 자동 수정 불가)는 더 긴 창으로 알람 폭주 방지.
const REASON_DEDUP_WINDOWS = {
  naver_publish_pending: 4 * 60 * 60 * 1000,
};
const CANONICAL_EVENT_TYPES = new Set([
  'blog_health_check',
  'blog-health_error',
  'alert',
  'system_error',
  'health_check',
]);

function classifyReason(message) {
  const compact = String(message || '').replace(/\s+/g, ' ').trim();
  if (/write EPIPE|broken pipe/i.test(compact)) return 'broken_pipe';
  if (/http 실패|응답 없음/i.test(compact)) return 'http_failure';
  if (/비정상 종료/i.test(compact)) return 'abnormal_exit';
  if (/미로드/i.test(compact)) return 'launchd_unloaded';
  if (/pid 없음|다운/i.test(compact)) return 'service_down';
  if (/발행 대기|미발행|ready 상태|naver.*publish/i.test(compact)) return 'naver_publish_pending';
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
  if (!CANONICAL_EVENT_TYPES.has(event_type)) return null;
  return `blog|${event_type}|${classifyReason(message)}`;
}

function canonicalizeBlogCriticalAlert({ event_type, alert_level, message }) {
  const signature = normalizeAlertSignature({ event_type, alert_level, message });
  const reason = classifyReason(message);
  const windowMs = REASON_DEDUP_WINDOWS[reason] || ALERT_DEDUPE_WINDOW_MS;
  const state = updateCriticalIncidentCache({
    cachePath: ALERT_DEDUPE_PATH,
    signature,
    message,
    latestReason: reason,
    windowMs,
    logPrefix: 'blog-alerts',
  });
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
  const incidentLine =
    `incident: canonical=1 count=${incident.count} first_seen=${incident.first_seen_at} last_seen=${incident.last_seen_at} reason=${incident.latest_reason}`;
  if (String(message || '').includes('incident: canonical=1 ')) return message;
  return `${message}\n${incidentLine}`;
}

module.exports = {
  canonicalizeBlogCriticalAlert,
  appendIncidentLine,
  classifyReason,
  REASON_DEDUP_WINDOWS,
  ALERT_DEDUPE_PATH,
};
