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
const HUB_ALARM_TIMEOUT_MS = Math.max(1000, Number(process.env.HUB_ALARM_TIMEOUT_MS || 5000) || 5000);
const STORE_PATH = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');
const TELEGRAM_RETRY_ATTEMPTS = 2;
const RECENT_ALERT_SNAPSHOT_PATH = String(process.env.HUB_ALARM_RECENT_ALERTS_PATH || '').trim()
  || path.join(env.AI_AGENT_WORKSPACE, 'recent-alerts.json');
const RECENT_ALERT_LIMIT = 50;

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
  sessionKey?: string;
  payload?: unknown;
  alarmType?: 'work' | 'report' | 'error' | string;
  visibility?: 'internal' | 'audit_only' | 'digest' | 'notify' | 'human_action' | 'emergency' | string;
  actionability?: 'none' | 'auto_repair' | 'needs_approval' | 'needs_human' | string;
  incidentKey?: string;
  title?: string;
  eventType?: string;
  criticalTelegramMode?: string;
  inlineKeyboard?: InlineKeyboard | null;
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

function _normalizeAlertText(value: unknown): string {
  if (value == null) return '';
  const text = String(value).trim();
  if (!text) return '';
  const lowered = text.toLowerCase();
  if (['undefined', 'null', 'nan', '[object object]'].includes(lowered)) return '';
  return text;
}

function _sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function _resolveTelegramRetryDelayMs(res: Response | null, body: any, fallbackMs = 3000): number {
  const retryAfterSec = Number(body?.parameters?.retry_after || res?.headers?.get('retry-after') || 0);
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    return Math.max(1000, retryAfterSec * 1000);
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
  // Use only the first line (structural headline) for stable hashing across
  // repeated alarms that share the same issue but have varying detail lines.
  const headline = _normalizeAlertText(message).split('\n')[0].slice(0, 120);
  return [
    _slugToken(team, 'general'),
    _slugToken(fromBot, 'unknown'),
    _slugToken(eventType, 'alarm'),
    _stableHash(headline),
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
  if (['work', 'report', 'error'].includes(explicit)) return explicit;
  const payloadType = (
    payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload)
  )
    ? _normalizeAlertText((payload as Record<string, unknown>).alarmType || (payload as Record<string, unknown>).alarm_type).toLowerCase()
    : '';
  if (['work', 'report', 'error'].includes(payloadType)) return payloadType;
  const corpus = [
    message,
    _extractEventType(message, payload) || '',
  ].join('\n').toLowerCase();
  if (/report|summary|digest|readiness|dashboard|리포트|보고|브리핑|정기/.test(corpus)) return 'report';
  if (alertLevel >= 3 || /error|fail|exception|timeout|provider_cooldown|오류|실패|장애|예외/.test(corpus)) return 'error';
  return 'work';
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
}) {
  const hubBaseUrl = String(env.HUB_BASE_URL || '').trim().replace(/\/+$/, '');
  const hubToken = String(env.HUB_AUTH_TOKEN || '').trim();
  if (!hubBaseUrl || !hubToken) {
    return { ok: false, skipped: true, error: 'hub_alarm_auth_missing' };
  }
  const url = `${hubBaseUrl}/hub/alarm`;
  const normalizedAlarmType = _inferAlarmType({ alarmType, alertLevel, message, payload });
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
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hubToken}`,
      },
      body: JSON.stringify({
        message,
        team,
        fromBot,
        severity: _mapAlertLevelToSeverity(alertLevel),
        title: title || `${team} alarm`,
        alarmType: normalizedAlarmType,
        visibility: visibility || undefined,
        actionability: actionability || undefined,
        incidentKey: normalizedIncidentKey,
        eventType: normalizedEventType,
        payload: {
          ...(payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {}),
          event_type: normalizedEventType,
        },
      }),
      signal: AbortSignal.timeout(HUB_ALARM_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => null);
    const accepted = _isHubAlarmDeliveryAccepted(response, body);
    const error = !accepted
      ? (body?.reason || body?.delivery_error || body?.error || 'hub_alarm_not_delivered')
      : null;
    return {
      ok: accepted,
      status: response.status,
      body,
      source: 'hub_alarm',
      error: response.ok ? error : (body?.error || `hub_alarm_http_${response.status}`),
    };
  } catch (error) {
    const err = error as ExecError;
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

function _writeRecentAlertSnapshot(row: RecentAlertSnapshotRow): void {
  try {
    fs.mkdirSync(path.dirname(RECENT_ALERT_SNAPSHOT_PATH), { recursive: true });
    const current = _readRecentAlertSnapshot();
    const next = [row, ...current].slice(0, RECENT_ALERT_LIMIT);
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
}: {
  message: string;
  team: string;
  alertLevel: number;
  fromBot: string;
  payload: unknown;
}): void {
  _writeRecentAlertSnapshot({
    from_bot: fromBot,
    team,
    event_type: _extractEventType(message, payload),
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
  sessionKey,
  payload = null,
  alarmType,
  visibility,
  actionability,
  incidentKey,
  title,
  eventType,
  inlineKeyboard = null,
}: PostAlarmInput) {
  const safeFromBot = _normalizeAlertText(fromBot) || 'unknown';
  const requestedTeam = _normalizeAlertText(team) || 'general';
  const safeMessage = _normalizeAlertText(message) || '유효한 본문 없음 (payload 확인 필요)';
  const prefix = alertLevel >= 3 ? `🚨 [긴급 alert_level=${alertLevel}] ` : '';
  const { groupId, topicIds } = await _getTopicInfo();
  const inferredAlarmType = _inferAlarmType({ alarmType, alertLevel, message: safeMessage, payload });
  const normalizedTeam = _resolveAlarmTopicKey({
    requestedTeam,
    alarmType: inferredAlarmType,
    visibility,
    alertLevel,
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
      _recordRecentAlertSnapshot({ message: safeMessage, team: requestedTeam, alertLevel, fromBot: safeFromBot, payload });
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
    alertLevel,
    fromBot: safeFromBot,
    payload,
    alarmType,
    visibility,
    actionability,
    incidentKey: incidentKey || sessionKey,
    title,
    eventType,
  });
  if (hubResult?.ok) {
    _recordRecentAlertSnapshot({ message: safeMessage, team: requestedTeam, alertLevel, fromBot: safeFromBot, payload });
    return hubResult;
  }
  if (hubResult?.error) {
    console.warn(`[hub-alarm-client] hub alarm failed: ${hubResult.error}`);
  }
  return {
    ok: false,
    source: 'hub_alarm',
    error: hubResult?.error || 'hub_alarm_not_delivered',
    fallback: 'disabled',
  };
}

export function readRecentAlertSnapshot(limit = 10): RecentAlertSnapshotRow[] {
  return _readRecentAlertSnapshot().slice(0, Math.max(0, limit));
}

export function _testOnly_isHubAlarmDeliveryAccepted(response: { ok: boolean }, body: any): boolean {
  return _isHubAlarmDeliveryAccepted(response as Response, body);
}
