/**
 * packages/core/lib/hub-alarm-client.js — Hub alarm 클라이언트
 *
 * 모든 봇 알람을 Hub /hub/alarm으로 우선 전달한다.
 * Legacy webhook fallback은 retired 상태이며 사용하지 않는다.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const env = require('./env.legacy.js');
const { fetchHubSecrets } = require('./hub-client.legacy.js');

const TIMEOUT_MS = 30_000;
const HUB_ALARM_TIMEOUT_MS = Math.max(1000, Number(process.env.HUB_ALARM_TIMEOUT_MS || 15000) || 15000);
const HUB_ALARM_CLIENT_CIRCUIT_FAILURES = Math.max(
  1,
  Number(process.env.HUB_ALARM_CLIENT_CIRCUIT_FAILURES || 5) || 5,
);
const HUB_ALARM_CLIENT_CIRCUIT_COOLDOWN_MS = Math.max(
  1000,
  Number(process.env.HUB_ALARM_CLIENT_CIRCUIT_COOLDOWN_MS || 60_000) || 60_000,
);
const HUB_ALARM_WARN_THROTTLE_MS = Math.max(
  1000,
  Number(process.env.HUB_ALARM_WARN_THROTTLE_MS || 60_000) || 60_000,
);
const HUB_ALARM_RATE_LIMIT_RETRY_AFTER_MS = Math.max(
  1000,
  Number(process.env.HUB_ALARM_RATE_LIMIT_RETRY_AFTER_MS || 60_000) || 60_000,
);
const HUB_ALARM_MAX_BODY_BYTES = Math.max(
  16_384,
  Number(process.env.HUB_ALARM_MAX_BODY_BYTES || 900_000) || 900_000,
);
const HUB_ALARM_MAX_MESSAGE_CHARS = Math.max(
  1_000,
  Number(process.env.HUB_ALARM_MAX_MESSAGE_CHARS || 20_000) || 20_000,
);
const HUB_ALARM_MAX_PAYLOAD_STRING_CHARS = Math.max(
  500,
  Number(process.env.HUB_ALARM_MAX_PAYLOAD_STRING_CHARS || 8_000) || 8_000,
);
const HUB_ALARM_MAX_PAYLOAD_ARRAY_ITEMS = Math.max(
  1,
  Number(process.env.HUB_ALARM_MAX_PAYLOAD_ARRAY_ITEMS || 50) || 50,
);
const HUB_ALARM_MAX_PAYLOAD_OBJECT_KEYS = Math.max(
  1,
  Number(process.env.HUB_ALARM_MAX_PAYLOAD_OBJECT_KEYS || 80) || 80,
);
const HUB_ALARM_MAX_PAYLOAD_DEPTH = Math.max(
  1,
  Number(process.env.HUB_ALARM_MAX_PAYLOAD_DEPTH || 4) || 4,
);
const STORE_PATH = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');
const TELEGRAM_RETRY_ATTEMPTS = 2;
const RECENT_ALERT_SNAPSHOT_PATH = String(process.env.HUB_ALARM_RECENT_ALERTS_PATH || '').trim()
  || path.join(env.AI_AGENT_WORKSPACE, 'recent-alerts.json');
const RECENT_ALERT_LIMIT = 50;
const RECENT_ALERT_SINGLETON_PRODUCERS = new Set([
  'hub:hourly-status-digest:hourly_status_digest',
]);

const TEAM_TOPIC = {
  general: 'general',
  reservation: 'ska',
  ska: 'ska',
  investment: 'luna',
  luna: 'luna',
  claude: 'claude_lead',
  'claude-lead': 'claude_lead',
  blog: 'blog',
  darwin: 'darwin',
  justin: 'justin',
  sigma: 'sigma',
  meeting: 'meeting',
  emergency: 'emergency',
  'ops-work': 'ops_work',
  'ops-reports': 'ops_reports',
  'ops-error-resolution': 'ops_error_resolution',
  'ops-emergency': 'ops_emergency',
};

const ENV_TOPIC_KEYS = {
  TELEGRAM_TOPIC_GENERAL: 'general',
  TELEGRAM_TOPIC_SKA: 'ska',
  TELEGRAM_TOPIC_LUNA: 'luna',
  TELEGRAM_TOPIC_CLAUDE_LEAD: 'claude_lead',
  TELEGRAM_TOPIC_BLOG: 'blog',
  TELEGRAM_TOPIC_LEGAL: 'legal',
  TELEGRAM_TOPIC_DARWIN: 'darwin',
  TELEGRAM_TOPIC_SIGMA: 'sigma',
  TELEGRAM_TOPIC_MEETING: 'meeting',
  TELEGRAM_TOPIC_EMERGENCY: 'emergency',
  TELEGRAM_TOPIC_OPS_WORK: 'ops_work',
  TELEGRAM_TOPIC_OPS_REPORTS: 'ops_reports',
  TELEGRAM_TOPIC_OPS_ERROR_RESOLUTION: 'ops_error_resolution',
  TELEGRAM_TOPIC_OPS_EMERGENCY: 'ops_emergency',
};

const OPS_TOPIC_KEYS = ['ops_work', 'ops_reports', 'ops_error_resolution', 'ops_emergency'];

type TopicIdMap = Record<string, string>;

type HubAlarmStore = {
  telegram?: {
    group_id?: string;
    topic_ids?: TopicIdMap;
    bot_token?: string;
    darwin_bot_token?: string;
  };
  darwin?: {
    telegram_bot_token?: string;
  };
};

type SecretTopicInfo = {
  group_id?: string;
  topic_ids?: TopicIdMap;
};

type TelegramInlineButton = {
  text: string;
  callback_data: string;
};

type InlineKeyboard = TelegramInlineButton[][];

type PostAlarmInput = {
  message: string;
  team?: string;
  alertLevel?: number;
  fromBot?: string;
  level?: number | string;
  bot?: string;
  sessionKey?: string;
  payload?: unknown;
  alarmType?: 'work' | 'report' | 'error' | string;
  visibility?: 'internal' | 'audit_only' | 'digest' | 'notify' | 'human_action' | 'emergency' | string;
  actionability?: 'none' | 'auto_repair' | 'needs_approval' | 'needs_human' | string;
  incidentKey?: string;
  title?: string;
  eventType?: string;
  event_type?: string;
  dedupeMinutes?: number;
  cooldownMinutes?: number;
  criticalTelegramMode?: string;
  inlineKeyboard?: InlineKeyboard | null;
  traceId?: string | null;
  trace_id?: string | null;
  cycleId?: string | null;
  cycle_id?: string | null;
};

type InlineTelegramInput = {
  message: string;
  team: string;
  fromBot: string;
  topicId: string | null;
  groupId: string;
  inlineKeyboard: InlineKeyboard;
};

type ExecError = Error & {
  status?: number;
};

type RecentAlertSnapshotRow = {
  from_bot: string;
  team: string;
  event_type: string | null;
  alert_level: number;
  message: string;
  status: string;
  created_at: string;
};

let _groupId: string | null = null;
let _topicIds: TopicIdMap | null = null;
let _telegramBotToken: string | null = null;
let _darwinTelegramBotToken: string | null = null;
let _hubAlarmConsecutiveFailures = 0;
let _hubAlarmCircuitOpenUntil = 0;
const _hubAlarmWarnLastAt = new Map<string, number>();

function _normalizeAlertText(value: unknown): string {
  if (value == null) return '';
  const text = String(value).trim();
  if (!text) return '';
  const lowered = text.toLowerCase();
  if (['undefined', 'null', 'nan', '[object object]'].includes(lowered)) return '';
  return text;
}

function _normalizeLegacyAlertLevel(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(1, Math.min(4, Math.trunc(value)));
  }
  const normalized = _normalizeAlertText(value).toLowerCase();
  if (!normalized) return null;
  if (['critical', 'emergency', 'fatal'].includes(normalized)) return 4;
  if (['error', 'err', 'fail', 'failed'].includes(normalized)) return 3;
  if (['warn', 'warning', 'alert'].includes(normalized)) return 2;
  if (['info', 'report', 'work', 'ok', 'success'].includes(normalized)) return 1;
  return null;
}

function _sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function _currentCycleTraceFields(): Record<string, string> {
  try {
    const cycleTrace = require('./cycle-trace');
    const current = cycleTrace.getCurrentTracePropagation?.() || {};
    const traceId = _normalizeAlertText(current.traceId || current.trace_id);
    const cycleId = _normalizeAlertText(current.cycleId || current.cycle_id);
    const fields: Record<string, string> = {};
    if (traceId) {
      fields.traceId = traceId;
      fields.trace_id = traceId;
    }
    if (cycleId) {
      fields.cycleId = cycleId;
      fields.cycle_id = cycleId;
    }
    return fields;
  } catch {
    return {};
  }
}

function _withCycleTraceFields(payload: Record<string, unknown>): Record<string, unknown> {
  const current = _currentCycleTraceFields();
  const traceId = _normalizeAlertText(payload.traceId || payload.trace_id);
  const cycleId = _normalizeAlertText(payload.cycleId || payload.cycle_id);
  return {
    ...payload,
    ...(!traceId && current.traceId ? { traceId: current.traceId, trace_id: current.trace_id } : {}),
    ...(!cycleId && current.cycleId ? { cycleId: current.cycleId, cycle_id: current.cycle_id } : {}),
  };
}

function _cycleTraceHeaders(payload: Record<string, unknown>): Record<string, string> {
  const traceId = _normalizeAlertText(payload.traceId || payload.trace_id);
  const cycleId = _normalizeAlertText(payload.cycleId || payload.cycle_id);
  return {
    ...(traceId ? { 'X-Hub-Trace-Id': traceId } : {}),
    ...(cycleId ? { 'X-Hub-Cycle-Id': cycleId } : {}),
  };
}

function _truncateString(value: unknown, maxChars: number): string {
  const text = value == null ? '' : String(value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 80))}\n...[hub_alarm_truncated chars=${text.length - maxChars}]`;
}

function _safeJsonStringify(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text : JSON.stringify({ value: String(value) });
  } catch (error) {
    return JSON.stringify({ unserializable: true, error: (error as Error).message });
  }
}

function _jsonByteLength(value: unknown): number {
  return Buffer.byteLength(_safeJsonStringify(value), 'utf8');
}

function _sanitizeHubAlarmValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return _truncateString(value, HUB_ALARM_MAX_PAYLOAD_STRING_CHARS);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return String(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: _truncateString(value.message, HUB_ALARM_MAX_PAYLOAD_STRING_CHARS),
      stack: _truncateString(value.stack || '', HUB_ALARM_MAX_PAYLOAD_STRING_CHARS),
    };
  }
  if (typeof value !== 'object') return _truncateString(value, HUB_ALARM_MAX_PAYLOAD_STRING_CHARS);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (depth >= HUB_ALARM_MAX_PAYLOAD_DEPTH) {
    return {
      __hub_alarm_truncated: 'max_depth',
      type: Array.isArray(value) ? 'array' : 'object',
    };
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, HUB_ALARM_MAX_PAYLOAD_ARRAY_ITEMS)
      .map((item) => _sanitizeHubAlarmValue(item, depth + 1, seen));
    if (value.length > HUB_ALARM_MAX_PAYLOAD_ARRAY_ITEMS) {
      items.push(`[hub_alarm_truncated_items=${value.length - HUB_ALARM_MAX_PAYLOAD_ARRAY_ITEMS}]`);
    }
    return items;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const next: Record<string, unknown> = {};
  for (const [key, item] of entries.slice(0, HUB_ALARM_MAX_PAYLOAD_OBJECT_KEYS)) {
    next[key] = _sanitizeHubAlarmValue(item, depth + 1, seen);
  }
  if (entries.length > HUB_ALARM_MAX_PAYLOAD_OBJECT_KEYS) {
    next.__hub_alarm_truncated_keys = entries.length - HUB_ALARM_MAX_PAYLOAD_OBJECT_KEYS;
  }
  return next;
}

function _fitHubAlarmBody(body: Record<string, unknown>, eventType: string): Record<string, unknown> {
  const initialBytes = _jsonByteLength(body);
  if (initialBytes <= HUB_ALARM_MAX_BODY_BYTES) return body;

  let previewChars = Math.max(1_000, Math.min(100_000, Math.floor(HUB_ALARM_MAX_BODY_BYTES / 3)));
  let next: Record<string, unknown> = {
    ...body,
    message: _truncateString(body.message, Math.min(HUB_ALARM_MAX_MESSAGE_CHARS, 4_000)),
    payload: {
      event_type: eventType,
      __hub_alarm_client_truncated: {
        reason: 'max_body_bytes',
        original_bytes: initialBytes,
        max_bytes: HUB_ALARM_MAX_BODY_BYTES,
      },
      preview: _truncateString(_safeJsonStringify(body.payload), previewChars),
    },
  };

  while (_jsonByteLength(next) > HUB_ALARM_MAX_BODY_BYTES && previewChars > 1_000) {
    previewChars = Math.max(1_000, Math.floor(previewChars / 2));
    next = {
      ...next,
      payload: {
        ...(next.payload as Record<string, unknown>),
        preview: _truncateString(_safeJsonStringify(body.payload), previewChars),
      },
    };
  }

  if (_jsonByteLength(next) > HUB_ALARM_MAX_BODY_BYTES) {
    next = {
      ...next,
      payload: {
        event_type: eventType,
        __hub_alarm_client_truncated: {
          reason: 'max_body_bytes',
          original_bytes: initialBytes,
          max_bytes: HUB_ALARM_MAX_BODY_BYTES,
          preview_omitted: true,
        },
      },
    };
  }
  return next;
}

function _isHubAlarmClientCircuitOpen(): boolean {
  return Date.now() < _hubAlarmCircuitOpenUntil;
}

function _recordHubAlarmClientResult(ok: boolean): void {
  if (ok) {
    _hubAlarmConsecutiveFailures = 0;
    _hubAlarmCircuitOpenUntil = 0;
    return;
  }
  _hubAlarmConsecutiveFailures += 1;
  if (_hubAlarmConsecutiveFailures >= HUB_ALARM_CLIENT_CIRCUIT_FAILURES) {
    _hubAlarmCircuitOpenUntil = Date.now() + HUB_ALARM_CLIENT_CIRCUIT_COOLDOWN_MS;
  }
}

function _warnHubAlarmFailure(error: unknown): void {
  const message = String(error || 'hub_alarm_not_delivered');
  const now = Date.now();
  const lastAt = _hubAlarmWarnLastAt.get(message) || 0;
  if (now - lastAt < HUB_ALARM_WARN_THROTTLE_MS) return;
  _hubAlarmWarnLastAt.set(message, now);
  console.warn(`[hub-alarm-client] hub alarm failed: ${message}`);
}

function _resolveTelegramRetryDelayMs(res: Response | null, body: any, fallbackMs = 3000): number {
  const retryAfterSec = Number(body?.parameters?.retry_after || res?.headers?.get('retry-after') || 0);
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    return Math.max(1000, retryAfterSec * 1000);
  }
  return fallbackMs;
}

function _resolveHttpRetryDelayMs(res: Response | null, body: any, fallbackMs = HUB_ALARM_RATE_LIMIT_RETRY_AFTER_MS): number {
  const bodyMs = Number(body?.retryAfterMs ?? body?.retry_after_ms ?? 0);
  if (Number.isFinite(bodyMs) && bodyMs > 0) {
    return Math.max(1, Math.trunc(bodyMs));
  }

  const bodySec = Number(body?.retryAfter ?? body?.retry_after ?? 0);
  if (Number.isFinite(bodySec) && bodySec > 0) {
    return Math.max(1000, Math.trunc(bodySec * 1000));
  }

  const retryAfter = String(res?.headers?.get('retry-after') || '').trim();
  if (retryAfter) {
    const retryAfterSec = Number(retryAfter);
    if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
      return Math.max(1000, Math.trunc(retryAfterSec * 1000));
    }
    const retryAfterDate = Date.parse(retryAfter);
    if (Number.isFinite(retryAfterDate)) {
      return Math.max(1000, retryAfterDate - Date.now());
    }
  }

  return fallbackMs;
}

function _readBooleanEnv(...names: string[]): boolean {
  for (const name of names) {
    const raw = String(process.env[name] || '').trim().toLowerCase();
    if (!raw) continue;
    return raw === 'true' || raw === '1' || raw === 'yes';
  }
  return false;
}

function _readFalseBooleanEnv(...names: string[]): boolean {
  for (const name of names) {
    const raw = String(process.env[name] || '').trim().toLowerCase();
    if (!raw) continue;
    return raw === 'false' || raw === '0' || raw === 'no' || raw === 'off';
  }
  return false;
}

function _readStoreTopicInfo() {
  try {
    const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as HubAlarmStore;
    const topicIds = store?.telegram?.topic_ids || {};
    const classMode = _readBooleanEnv('HUB_ALARM_USE_CLASS_TOPICS')
      || ((store?.telegram as Record<string, unknown> | undefined)?.topic_alias_mode === 'class_topics'
        && !_readFalseBooleanEnv('HUB_ALARM_USE_CLASS_TOPICS'));
    return {
      groupId: store?.telegram?.group_id || '',
      topicIds: classMode
        ? Object.fromEntries(
          OPS_TOPIC_KEYS
            .filter((key) => topicIds[key] != null && topicIds[key] !== '')
            .map((key) => [key, topicIds[key]]),
        )
        : topicIds,
    };
  } catch {
    return { groupId: '', topicIds: {} };
  }
}

function _filterClassTopicIds(topicIds: TopicIdMap): TopicIdMap {
  return Object.fromEntries(
    OPS_TOPIC_KEYS
      .filter((key) => topicIds[key] != null && topicIds[key] !== '')
      .map((key) => [key, topicIds[key]]),
  );
}

function _readEnvTopicInfo(classTopicMode: boolean): TopicIdMap {
  const topics: TopicIdMap = {};
  for (const [envKey, topicKey] of Object.entries(ENV_TOPIC_KEYS)) {
    const value = process.env[envKey];
    if (value == null || value === '') continue;
    if (classTopicMode && !OPS_TOPIC_KEYS.includes(topicKey)) continue;
    topics[topicKey] = value;
  }
  return topics;
}

async function _getTopicInfo(): Promise<{ groupId: string; topicIds: TopicIdMap }> {
  if (_groupId && _topicIds) {
    return { groupId: _groupId, topicIds: _topicIds };
  }

  const hubData = await fetchHubSecrets('telegram') as SecretTopicInfo | null;
  const storeData = _readStoreTopicInfo();

  _groupId = hubData?.group_id
    || process.env.TELEGRAM_GROUP_ID
    || storeData.groupId
    || '';
  const baseTopicIds = {
    ...(storeData.topicIds || {}),
    ...(hubData?.topic_ids || {}),
  };
  const classTopicMode = _classTopicModeEnabled(baseTopicIds);
  _topicIds = {
    ...baseTopicIds,
    ..._readEnvTopicInfo(classTopicMode),
  };
  if (classTopicMode) _topicIds = _filterClassTopicIds(_topicIds);

  return { groupId: _groupId, topicIds: _topicIds };
}

function _classTopicModeEnabled(topicIds: TopicIdMap): boolean {
  if (_readBooleanEnv('HUB_ALARM_USE_CLASS_TOPICS')) return true;
  if (_readFalseBooleanEnv('HUB_ALARM_USE_CLASS_TOPICS')) return false;
  return OPS_TOPIC_KEYS.every((key) => topicIds?.[key]);
}

function _resolveAlarmTopicKey({
  requestedTeam,
  alarmType,
  visibility,
  alertLevel,
  message,
  topicIds,
}: {
  requestedTeam: string;
  alarmType?: string;
  visibility?: string;
  alertLevel: number;
  message: string;
  topicIds: TopicIdMap;
}): string {
  if (!_classTopicModeEnabled(topicIds)) {
    return TEAM_TOPIC[requestedTeam as keyof typeof TEAM_TOPIC] || 'general';
  }
  const explicitTeamTopic = TEAM_TOPIC[requestedTeam as keyof typeof TEAM_TOPIC] || 'general';
  if (['ops_work', 'ops_reports', 'ops_error_resolution', 'ops_emergency'].includes(explicitTeamTopic)) {
    return explicitTeamTopic;
  }
  const normalizedVisibility = String(visibility || '').trim().toLowerCase();
  const normalizedAlarmType = String(alarmType || '').trim().toLowerCase();
  const corpus = String(message || '').toLowerCase();
  if (
    alertLevel >= 4
    || normalizedVisibility === 'emergency'
    || /critical|긴급|🚨/.test(corpus)
  ) return 'ops_emergency';
  if (
    normalizedAlarmType === 'report'
    || /report|summary|digest|readiness|dashboard|리포트|보고|브리핑|정기|요약|주간|일간|월간/i.test(corpus)
  ) return 'ops_reports';
  if (
    normalizedAlarmType === 'error'
    || alertLevel >= 3
    || /error|fail|failed|exception|timeout|provider_cooldown|오류|실패|장애|예외|경고/i.test(corpus)
  ) return 'ops_error_resolution';
  return 'ops_work';
}

async function _getTelegramBotToken(): Promise<string> {
  if (_telegramBotToken) return _telegramBotToken;

  const telegramData = await fetchHubSecrets('telegram') as { bot_token?: string } | null;
  const reservationData = await fetchHubSecrets('reservation-shared') as { telegram_bot_token?: string } | null;

  _telegramBotToken = telegramData?.bot_token
    || reservationData?.telegram_bot_token
    || '';
  return _telegramBotToken;
}

async function _getDarwinTelegramBotToken(): Promise<string> {
  if (_darwinTelegramBotToken) return _darwinTelegramBotToken;

  try {
    const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as HubAlarmStore;
    _darwinTelegramBotToken = store?.darwin?.telegram_bot_token
      || store?.telegram?.darwin_bot_token
      || process.env.DARWIN_TELEGRAM_BOT_TOKEN
      || '';
  } catch {
    _darwinTelegramBotToken = process.env.DARWIN_TELEGRAM_BOT_TOKEN || '';
  }

  return _darwinTelegramBotToken;
}

function _extractEventType(message: string, payload: unknown): string | null {
  const payloadEventType = (
    payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    typeof (payload as Record<string, unknown>).event_type === 'string'
  )
    ? String((payload as Record<string, unknown>).event_type || '').trim()
    : '';
  if (payloadEventType) {
    return payloadEventType;
  }

  const match = String(message || '').match(/(?:^|\n)\s*event_type\s*:\s*([^\n]+)/i);
  return match?.[1]?.trim() || null;
}

function _slugToken(value: unknown, fallback = 'alarm'): string {
  const text = _normalizeAlertText(value)
    .toLowerCase()
    .replace(/[^a-z0-9가-힣._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return text || fallback;
}

function _stableHash(value: unknown): string {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 12);
}

function _extractCanonicalIncidentReason(message: string): string {
  const match = String(message || '').match(/(?:^|\n)\s*incident:\s*canonical=1\b[^\n]*\breason=([^\s\n]+)/i);
  return _normalizeAlertText(match?.[1] || '');
}

function _deriveEventType({
  eventType,
  message,
  payload,
  fromBot,
  alarmType,
}: {
  eventType?: string;
  message: string;
  payload: unknown;
  fromBot: string;
  alarmType: string;
}): string {
  return _normalizeAlertText(eventType)
    || _extractEventType(message, payload)
    || `${_slugToken(fromBot, 'unknown')}_${_slugToken(alarmType, 'alarm')}`;
}

function _deriveIncidentKey({
  incidentKey,
  sessionKey,
  team,
  fromBot,
  eventType,
  message,
}: {
  incidentKey?: string;
  sessionKey?: string;
  team: string;
  fromBot: string;
  eventType: string;
  message: string;
}): string {
  const explicit = _normalizeAlertText(incidentKey || sessionKey);
  if (explicit) return explicit;
  const canonicalReason = _extractCanonicalIncidentReason(message);
  // Use only the first line (structural headline) for stable hashing across
  // repeated alarms that share the same issue but have varying detail lines.
  const headline = _normalizeAlertText(message).split('\n')[0].slice(0, 120);
  return [
    _slugToken(team, 'general'),
    _slugToken(fromBot, 'unknown'),
    _slugToken(eventType, 'alarm'),
    _stableHash(canonicalReason || headline),
  ].join(':');
}

function _mapAlertLevelToSeverity(level: number): 'info' | 'warn' | 'error' | 'critical' {
  if (level >= 4) return 'critical';
  if (level === 3) return 'error';
  if (level === 2) return 'warn';
  return 'info';
}

function _inferAlarmType({
  alarmType,
  alertLevel,
  message,
  payload,
}: {
  alarmType?: string;
  alertLevel: number;
  message: string;
  payload: unknown;
}): string {
  const explicit = _normalizeAlertText(alarmType).toLowerCase();
  if (['work', 'report', 'error', 'critical'].includes(explicit)) return explicit;
  const payloadType = (
    payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload)
  )
    ? _normalizeAlertText((payload as Record<string, unknown>).alarmType || (payload as Record<string, unknown>).alarm_type).toLowerCase()
    : '';
  if (['work', 'report', 'error', 'critical'].includes(payloadType)) return payloadType;
  if (alertLevel >= 4) return 'critical';
  const corpus = [
    message,
    _extractEventType(message, payload) || '',
  ].join('\n').toLowerCase();
  if (/report|summary|digest|readiness|dashboard|리포트|보고|브리핑|정기/.test(corpus)) return 'report';
  if (alertLevel >= 3 || /error|fail|exception|timeout|provider_cooldown|오류|실패|장애|예외/.test(corpus)) return 'error';
  return 'work';
}

function _normalizeVisibility(value: unknown): string {
  const normalized = _normalizeAlertText(value).toLowerCase();
  return ['internal', 'audit_only', 'digest', 'notify', 'human_action', 'emergency'].includes(normalized)
    ? normalized
    : '';
}

function _normalizeActionability(value: unknown): string {
  const normalized = _normalizeAlertText(value).toLowerCase();
  return ['none', 'auto_repair', 'needs_approval', 'needs_human'].includes(normalized)
    ? normalized
    : '';
}

function _defaultVisibility({
  alarmType,
  actionability,
}: {
  alarmType: string;
  actionability?: string;
}): string {
  if (actionability === 'needs_human' || actionability === 'needs_approval') return 'human_action';
  if (alarmType === 'critical') return 'emergency';
  if (alarmType === 'work' || alarmType === 'report') return 'notify';
  if (alarmType === 'error') return 'internal';
  return 'internal';
}

function _defaultActionability({
  alarmType,
  visibility,
}: {
  alarmType: string;
  visibility: string;
}): string {
  if (visibility === 'emergency') return 'needs_human';
  if (visibility === 'human_action') return 'needs_approval';
  if (alarmType === 'critical') return 'needs_human';
  if (alarmType === 'error') return 'auto_repair';
  return 'none';
}

function _isHubAlarmDeliveryAccepted(response: Response, body: any): boolean {
  if (!response.ok || body?.ok !== true) return false;
  if (body?.suppressed === true || body?.reason === 'alerts_disabled') return false;
  if (body?.deduped === true) return true;
  if (
    body?.governed === true
    && ['internal', 'audit_only', 'digest'].includes(String(body?.visibility || '').toLowerCase())
  ) {
    return true;
  }
  if (Object.prototype.hasOwnProperty.call(body || {}, 'delivered')) {
    return body?.delivered === true;
  }
  return true;
}

async function _postAlarmViaHub({
  message,
  team,
  alertLevel,
  fromBot,
  payload,
  alarmType,
  visibility,
  actionability,
  incidentKey,
  title,
  eventType,
  dedupeMinutes,
}: {
  message: string;
  team: string;
  alertLevel: number;
  fromBot: string;
  payload: unknown;
  alarmType?: string;
  visibility?: string;
  actionability?: string;
  incidentKey?: string;
  title?: string;
  eventType?: string;
  dedupeMinutes?: number;
}) {
  const hubBaseUrl = String(env.HUB_BASE_URL || '').trim().replace(/\/+$/, '');
  const hubToken = String(env.HUB_AUTH_TOKEN || '').trim();
  if (!hubBaseUrl || !hubToken) {
    return { ok: false, skipped: true, error: 'hub_alarm_auth_missing' };
  }
  if (_isHubAlarmClientCircuitOpen()) {
    return {
      ok: false,
      skipped: true,
      source: 'hub_alarm',
      error: 'hub_alarm_client_circuit_open',
      retryAfterMs: Math.max(0, _hubAlarmCircuitOpenUntil - Date.now()),
    };
  }
  const url = `${hubBaseUrl}/hub/alarm`;
  const normalizedAlarmType = _inferAlarmType({ alarmType, alertLevel, message, payload });
  const normalizedVisibility = _normalizeVisibility(visibility)
    || _defaultVisibility({
      alarmType: normalizedAlarmType,
      actionability: _normalizeActionability(actionability),
    });
  const normalizedActionability = _normalizeActionability(actionability)
    || _defaultActionability({
      alarmType: normalizedAlarmType,
      visibility: normalizedVisibility,
    });
  const normalizedEventType = _deriveEventType({
    eventType,
    message,
    payload,
    fromBot,
    alarmType: normalizedAlarmType,
  });
  const normalizedIncidentKey = _deriveIncidentKey({
    incidentKey,
    team,
    fromBot,
    eventType: normalizedEventType,
    message,
  });
  const normalizedDedupeMinutes = Number.isFinite(Number(dedupeMinutes))
    ? Math.max(1, Math.min(1440, Math.trunc(Number(dedupeMinutes))))
    : null;
  const sanitizedPayload = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (_sanitizeHubAlarmValue(payload) as Record<string, unknown>)
    : (payload == null ? {} : { value: _sanitizeHubAlarmValue(payload) });
  const tracedPayload = _withCycleTraceFields(sanitizedPayload);
  const hubAlarmBody = _fitHubAlarmBody({
    message: _truncateString(message, HUB_ALARM_MAX_MESSAGE_CHARS),
    team,
    fromBot,
    severity: _mapAlertLevelToSeverity(alertLevel),
    title: title || `${team} alarm`,
    alarmType: normalizedAlarmType,
    visibility: normalizedVisibility,
    actionability: normalizedActionability,
    incidentKey: normalizedIncidentKey,
    eventType: normalizedEventType,
    dedupeMinutes: normalizedDedupeMinutes,
    payload: {
      ...tracedPayload,
      event_type: normalizedEventType,
    },
  }, normalizedEventType);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hubToken}`,
        ..._cycleTraceHeaders(tracedPayload),
      },
      body: JSON.stringify(hubAlarmBody),
      signal: AbortSignal.timeout(HUB_ALARM_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => null);
    const accepted = _isHubAlarmDeliveryAccepted(response, body);
    _recordHubAlarmClientResult(accepted);
    const error = !accepted
      ? (body?.reason || body?.delivery_error || body?.error || 'hub_alarm_not_delivered')
      : null;
    const retryAfterMs = response.status === 429
      ? _resolveHttpRetryDelayMs(response, body)
      : undefined;
    return {
      ok: accepted,
      status: response.status,
      body,
      source: 'hub_alarm',
      error: response.ok ? error : (body?.error || `hub_alarm_http_${response.status}`),
      retryable: response.status === 429 ? true : undefined,
      retryAfterMs,
    };
  } catch (error) {
    const err = error as ExecError;
    _recordHubAlarmClientResult(false);
    return { ok: false, source: 'hub_alarm', error: err.message };
  }
}

function _readRecentAlertSnapshot(): RecentAlertSnapshotRow[] {
  try {
    if (!fs.existsSync(RECENT_ALERT_SNAPSHOT_PATH)) {
      return [];
    }
    const rows = JSON.parse(fs.readFileSync(RECENT_ALERT_SNAPSHOT_PATH, 'utf8'));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function _buildRecentAlertSnapshotSingletonKey(row: Partial<RecentAlertSnapshotRow>): string {
  const fromBot = _normalizeAlertText(row?.from_bot).toLowerCase();
  const team = _normalizeAlertText(row?.team).toLowerCase();
  const eventType = _normalizeAlertText(row?.event_type).toLowerCase();
  return `${team}:${fromBot}:${eventType}`;
}

function _dedupeRecentAlertSnapshot(rows: RecentAlertSnapshotRow[]): RecentAlertSnapshotRow[] {
  const seenSingletons = new Set<string>();
  const next: RecentAlertSnapshotRow[] = [];
  for (const row of rows) {
    const singletonKey = _buildRecentAlertSnapshotSingletonKey(row);
    if (RECENT_ALERT_SINGLETON_PRODUCERS.has(singletonKey)) {
      if (seenSingletons.has(singletonKey)) continue;
      seenSingletons.add(singletonKey);
    }
    next.push(row);
  }
  return next;
}

function _writeRecentAlertSnapshot(row: RecentAlertSnapshotRow): void {
  try {
    fs.mkdirSync(path.dirname(RECENT_ALERT_SNAPSHOT_PATH), { recursive: true });
    const current = _readRecentAlertSnapshot();
    const next = _dedupeRecentAlertSnapshot([row, ...current]).slice(0, RECENT_ALERT_LIMIT);
    fs.writeFileSync(RECENT_ALERT_SNAPSHOT_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.warn(`[hub-alarm-client] recent alert snapshot 저장 실패: ${(error as Error).message}`);
  }
}

function _recordRecentAlertSnapshot({
  message,
  team,
  alertLevel,
  fromBot,
  payload,
  eventType,
}: {
  message: string;
  team: string;
  alertLevel: number;
  fromBot: string;
  payload: unknown;
  eventType?: string;
}): void {
  _writeRecentAlertSnapshot({
    from_bot: fromBot,
    team,
    event_type: eventType || _extractEventType(message, payload),
    alert_level: alertLevel,
    message,
    status: 'sent',
    created_at: new Date().toISOString(),
  });
}

async function _sendInlineTelegram({ message, team, fromBot, topicId, groupId, inlineKeyboard }: InlineTelegramInput) {
  const botToken = team === 'darwin'
    ? (await _getDarwinTelegramBotToken()) || (await _getTelegramBotToken())
    : await _getTelegramBotToken();
  if (!botToken || !groupId) {
    console.warn('[hub-alarm-client] inline telegram 발송 실패: bot token/group id 미설정');
    return { ok: false, error: 'no_telegram_token_or_group' };
  }

  try {
    const payload = {
      chat_id: groupId,
      text: `[${fromBot}→${team}] ${message}`,
      message_thread_id: topicId || undefined,
      reply_markup: {
        inline_keyboard: inlineKeyboard,
      },
    };

    for (let attempt = 1; attempt <= TELEGRAM_RETRY_ATTEMPTS; attempt += 1) {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok === true) {
        return { ok: true, status: res.status, body };
      }

      if (res.status === 429 && attempt < TELEGRAM_RETRY_ATTEMPTS) {
        const delayMs = _resolveTelegramRetryDelayMs(res, body, 3000);
        console.warn(`[hub-alarm-client] inline telegram 429 — ${delayMs}ms 후 재시도`);
        await _sleep(delayMs);
        continue;
      }

      return { ok: false, status: res.status, body };
    }

    return { ok: false, error: 'telegram_retry_exhausted' };
  } catch (e) {
    const error = e as ExecError;
    console.warn(`[hub-alarm-client] inline telegram 실패: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

export async function postAlarm({
  message,
  team = 'general',
  alertLevel = 2,
  fromBot = 'unknown',
  level,
  bot,
  sessionKey,
  payload = null,
  alarmType,
  visibility,
  actionability,
  incidentKey,
  title,
  eventType,
  event_type,
  dedupeMinutes,
  cooldownMinutes,
  inlineKeyboard = null,
}: PostAlarmInput) {
  const normalizedAlertLevel = _normalizeLegacyAlertLevel(level) ?? alertLevel;
  const safeFromBot = _normalizeAlertText(fromBot) || _normalizeAlertText(bot) || 'unknown';
  const requestedTeam = _normalizeAlertText(team) || 'general';
  const safeMessage = _normalizeAlertText(message) || '유효한 본문 없음 (payload 확인 필요)';
  const normalizedEventTypeInput = _normalizeAlertText(eventType) || _normalizeAlertText(event_type) || undefined;
  const prefix = normalizedAlertLevel >= 3 ? `🚨 [긴급 alert_level=${normalizedAlertLevel}] ` : '';
  const { groupId, topicIds } = await _getTopicInfo();
  const inferredAlarmType = _inferAlarmType({ alarmType, alertLevel: normalizedAlertLevel, message: safeMessage, payload });
  const normalizedTeam = _resolveAlarmTopicKey({
    requestedTeam,
    alarmType: inferredAlarmType,
    visibility,
    alertLevel: normalizedAlertLevel,
    message: safeMessage,
    topicIds,
  });
  const topicId = topicIds?.[normalizedTeam] || topicIds?.general || null;
  if (Array.isArray(inlineKeyboard) && inlineKeyboard.length > 0) {
    const inlineResult = await _sendInlineTelegram({
      message: `${prefix}${safeMessage}`,
      team: requestedTeam,
      fromBot: safeFromBot,
      topicId,
      groupId,
      inlineKeyboard,
    });
    if (inlineResult?.ok) {
      _recordRecentAlertSnapshot({
        message: safeMessage,
        team: requestedTeam,
        alertLevel,
        fromBot: safeFromBot,
        payload,
        eventType: normalizedEventTypeInput,
      });
    }
    return inlineResult;
  }

  const hubDirectBlocked = _readBooleanEnv('HUB_ALARM_SKIP_DIRECT');
  if (hubDirectBlocked) {
    return {
      ok: false,
      source: 'hub_alarm',
      error: 'hub_alarm_skipped',
      fallback: 'disabled',
    };
  }

  const hubResult = await _postAlarmViaHub({
      message: safeMessage,
      team: requestedTeam,
      alertLevel: normalizedAlertLevel,
      fromBot: safeFromBot,
      payload,
      alarmType,
      visibility,
      actionability,
      incidentKey: incidentKey || sessionKey,
      title,
      eventType: normalizedEventTypeInput,
      dedupeMinutes: dedupeMinutes ?? cooldownMinutes,
    });
  if (hubResult?.ok) {
    _recordRecentAlertSnapshot({ message: safeMessage, team: requestedTeam, alertLevel: normalizedAlertLevel, fromBot: safeFromBot, payload });
    return hubResult;
  }
  if (hubResult?.error) {
    _warnHubAlarmFailure(hubResult.error);
  }
  return {
    ok: false,
    status: hubResult?.status,
    source: 'hub_alarm',
    error: hubResult?.error || 'hub_alarm_not_delivered',
    fallback: 'disabled',
    retryable: hubResult?.retryable,
    retryAfterMs: hubResult?.retryAfterMs,
  };
}

export function readRecentAlertSnapshot(limit = 10): RecentAlertSnapshotRow[] {
  return _readRecentAlertSnapshot().slice(0, Math.max(0, limit));
}

export function _testOnly_isHubAlarmDeliveryAccepted(response: { ok: boolean }, body: any): boolean {
  return _isHubAlarmDeliveryAccepted(response as Response, body);
}

export function _testOnly_fitHubAlarmBody(body: Record<string, unknown>, eventType = 'test_event'): Record<string, unknown> {
  return _fitHubAlarmBody(body, eventType);
}
