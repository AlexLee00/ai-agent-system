const fs = require('fs');
const { runWithN8nFallback } = require('./n8n-runner');
const openclawClient = require('./openclaw-client');

const ALERT_LEVEL_LABELS = {
  1: '안내',
  2: '경고',
  3: '높음',
  4: '긴급 장애',
};

const ALERT_LEVEL_ICONS = {
  1: 'ℹ️',
  2: '⚠️',
  3: '🟠',
  4: '🚨',
};

const MOBILE_DETAIL_LIMIT = 4;
const MOBILE_SECTION_LINE_LIMIT = 3;
const MOBILE_LINE_MAX = 88;
const MOBILE_DIVIDER = '──────────';

const DELIVERY_STATE = new Map();
const DEFAULT_CRITICAL_WEBHOOK_URL = process.env.N8N_CRITICAL_WEBHOOK || 'http://127.0.0.1:5678/webhook/critical';
const PAYLOAD_WARNING_LOG = process.env.REPORTING_PAYLOAD_WARNING_LOG || '/tmp/reporting-payload-warnings.jsonl';
const LEGACY_QUEUE_USAGE_LOG = process.env.MAINBOT_QUEUE_USAGE_LOG || '/tmp/mainbot-queue-usage.jsonl';
const MAX_WARNING_LOG_BYTES = 512 * 1024;
const TELEGRAM_API_RETRY_ATTEMPTS = 2;
const LEGACY_QUEUE_WARNED_KEYS = new Set<string>();

type AlertLevel = 1 | 2 | 3 | 4;

type PayloadLink = {
  label: string;
  href?: string;
};

type NormalizedPayload = {
  title?: string;
  summary?: string;
  action?: string;
  detail?: string;
  details?: string[];
  links?: PayloadLink[];
  [key: string]: unknown;
} | null;

type NormalizedEvent = {
  from_bot: string;
  team: string;
  event_type: string;
  alert_level: number;
  message: string;
  payload: NormalizedPayload;
};

type EventInput = {
  from_bot?: string;
  team?: string;
  event_type?: string;
  alert_level?: number;
  message?: string;
  payload?: unknown;
};

type SnippetEvent = NormalizedEvent & {
  title: string;
  lines: string[];
  detailHint: string;
};

type NoticeEvent = NormalizedEvent & {
  title: string;
  summary: string;
  details: string[];
  action: string;
  actionLabel: string;
  footer: string;
};

type ReportSection = {
  title: string;
  lines: string[];
};

type ReportEvent = NormalizedEvent & {
  title: string;
  summary: string;
  sections: ReportSection[];
  footer: string;
};

type DeliveryPolicy = {
  key?: string;
  dedupe?: boolean;
  cooldownMs?: number;
  quietHours?: {
    maxAlertLevel?: number;
    timezone?: string;
    startHour?: number;
    endHour?: number;
  } | null;
};

type PolicyDecision = {
  allowed: boolean;
  reason: string;
  policy: {
    dedupe: boolean;
    cooldownMs: number;
    quietHours: DeliveryPolicy['quietHours'];
    channel: string;
  };
  dedupeKey?: string;
  retryAfterMs?: number;
};

type QueuePublisherInput = {
  pgPool: { run: (schema: string, sql: string, params: unknown[]) => Promise<unknown> };
  schema?: string;
  table?: string;
  event: EventInput;
  policy?: DeliveryPolicy;
};

type TelegramPublisherInput = {
  sender: { send: (team: string, message: string) => Promise<boolean>; sendCritical: (team: string, message: string) => Promise<boolean> };
  topicTeam: string;
  event: EventInput;
  prefix?: string;
  criticalMode?: string;
  policy?: DeliveryPolicy;
};

type TelegramApiPublisherInput = {
  token: string;
  chatId: string;
  threadId?: string | null;
  event: EventInput;
  parseMode?: string;
  replyMarkup?: unknown;
  disableWebPagePreview?: boolean;
  policy?: DeliveryPolicy;
};

type RagPublisherInput = {
  ragStore: { store: (collection: string, content: string, metadata: Record<string, unknown>, sourceBot: string) => Promise<unknown> };
  collection?: string;
  sourceBot?: string;
  event: EventInput;
  metadata?: Record<string, unknown>;
  contentBuilder?: ((event: NormalizedEvent) => string) | null;
  policy?: DeliveryPolicy;
};

type N8nPublisherInput = {
  circuitName?: string;
  webhookCandidates: string[];
  healthUrl?: string;
  event: EventInput;
  bodyBuilder?: ((event: NormalizedEvent) => unknown) | null;
  directResult?: { ok?: boolean; source?: string };
  policy?: DeliveryPolicy;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveTelegramRetryDelayMs(res: Response | null, data: any, fallbackMs = 3000): number {
  const retryAfterSec = Number(data?.parameters?.retry_after || res?.headers?.get('retry-after') || 0);
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    return Math.max(1000, retryAfterSec * 1000);
  }
  return fallbackMs;
}

function normalizeMessageText(message = ''): string {
  const lines = String(message || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line: string) => line.replace(/[ \t]+$/g, ''))
    .map((line: string) => {
      const trimmed = line.trim();
      if (/^[━═─-]{8,}$/.test(trimmed)) return MOBILE_DIVIDER;
      return line;
    });

  const compact = [];
  let previousBlank = false;
  for (const line of lines) {
    const blank = line.trim() === '';
    if (blank && previousBlank) continue;
    compact.push(line);
    previousBlank = blank;
  }

  return compact.join('\n').trim();
}

function appendPayloadWarning(entry: Record<string, unknown>): void {
  try {
    if (fs.existsSync(PAYLOAD_WARNING_LOG)) {
      const stat = fs.statSync(PAYLOAD_WARNING_LOG);
      if (stat.size > MAX_WARNING_LOG_BYTES) {
        fs.truncateSync(PAYLOAD_WARNING_LOG, 0);
      }
    }
    fs.appendFileSync(PAYLOAD_WARNING_LOG, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (error) {
    console.warn(`[reporting-hub] payload warning log failed: ${(error as Error).message}`);
  }
}

function recordPayloadWarnings(event: NormalizedEvent, warnings: string[]): void {
  if (!Array.isArray(warnings) || warnings.length === 0) return;
  appendPayloadWarning({
    ts: new Date().toISOString(),
    from_bot: String(event?.from_bot || 'unknown'),
    team: String(event?.team || 'general'),
    event_type: String(event?.event_type || 'report'),
    alert_level: Number.isFinite(Number(event?.alert_level)) ? Number(event.alert_level) : 2,
    warnings,
  });
}

function recordLegacyQueueUsage(event: NormalizedEvent, schema: string, table: string): void {
  const warnKey = `${schema}:${table}:${event.team}:${event.from_bot}:${event.event_type}`;
  if (!LEGACY_QUEUE_WARNED_KEYS.has(warnKey)) {
    LEGACY_QUEUE_WARNED_KEYS.add(warnKey);
    console.warn(
      `[reporting-hub] legacy queue publish used: ${schema}.${table} ` +
      `team=${event.team} from_bot=${event.from_bot} event_type=${event.event_type}`,
    );
  }

  try {
    if (fs.existsSync(LEGACY_QUEUE_USAGE_LOG)) {
      const stat = fs.statSync(LEGACY_QUEUE_USAGE_LOG);
      if (stat.size > MAX_WARNING_LOG_BYTES) {
        fs.truncateSync(LEGACY_QUEUE_USAGE_LOG, 0);
      }
    }
    fs.appendFileSync(LEGACY_QUEUE_USAGE_LOG, `${JSON.stringify({
      ts: new Date().toISOString(),
      schema,
      table,
      team: event.team,
      from_bot: event.from_bot,
      event_type: event.event_type,
      alert_level: event.alert_level,
    })}\n`, 'utf8');
  } catch (error) {
    console.warn(`[reporting-hub] legacy queue usage log failed: ${(error as Error).message}`);
  }
}

export function getRecentPayloadWarnings({
  limit = 50,
  withinHours = 24,
} = {}): Record<string, unknown>[] {
  try {
    if (!fs.existsSync(PAYLOAD_WARNING_LOG)) return [];
    const minTs = Date.now() - (withinHours * 60 * 60 * 1000);
    const raw = fs.readFileSync(PAYLOAD_WARNING_LOG, 'utf8').trim();
    if (!raw) return [];
    const lines = raw.split('\n');
    const entries = [];
    for (let index = lines.length - 1; index >= 0 && entries.length < limit; index -= 1) {
      try {
        const parsed = JSON.parse(lines[index]) as Record<string, unknown>;
        const ts = Date.parse(String(parsed.ts || ''));
        if (!Number.isFinite(ts) || ts < minTs) continue;
        entries.push(parsed);
      } catch {
        continue;
      }
    }
    return entries.reverse();
  } catch (error) {
    console.warn(`[reporting-hub] payload warning read failed: ${(error as Error).message}`);
    return [];
  }
}

export function summarizePayloadWarnings(entries: Array<Record<string, unknown>> = []) {
  const producerCounts = new Map<string, number>();
  for (const entry of entries) {
    const key = `${entry.team || 'general'}/${entry.from_bot || 'unknown'}`;
    producerCounts.set(key, (producerCounts.get(key) || 0) + 1);
  }
  const topProducers = [...producerCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([producer, count]) => `  ${producer}: ${count}건`);
  return {
    count: entries.length,
    topProducers,
    latest: entries.length > 0 ? entries[entries.length - 1] : null,
  };
}

function compactLine(line: string, maxLength = MOBILE_LINE_MAX): string {
  const text = String(line || '')
    .replace(/\s+/g, ' ')
    .replace(/[━═─-]{8,}/g, MOBILE_DIVIDER)
    .trim();
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function compactSectionTitle(title: string): string {
  return compactLine(String(title || '').replace(/[━═─]/g, ' ').replace(/\s+/g, ' ').trim(), 40);
}

function compactNoticeTitle(title: string): string {
  const normalized = String(title || '')
    .replace(/^[^\w가-힣]+\s*/, '')
    .replace(/^루나 메트릭 경고\s*[—-]\s*/u, '루나 경고 · ')
    .replace(/^오늘 예약 현황\s*[—-]\s*/u, '오늘 예약 · ')
    .replace(/^오늘 예약 현황\s*/u, '오늘 예약 ')
    .replace(/국내주식 수집/gu, '국내 수집')
    .replace(/해외주식 수집/gu, '해외 수집')
    .replace(/\s+/g, ' ')
    .trim();
  return compactLine(normalized, 40);
}

function compactLines(lines: string[] = [], limit = MOBILE_DETAIL_LIMIT): string[] {
  const normalized = lines
    .map((line) => compactLine(line))
    .filter(Boolean);
  if (normalized.length <= limit) return normalized;
  return [
    ...normalized.slice(0, limit),
    `… 외 ${normalized.length - limit}줄`,
  ];
}

export function validatePayloadSchema(payload: unknown = null): { payload: NormalizedPayload; warnings: string[] } {
  if (payload == null) {
    return { payload: null, warnings: [] };
  }

  const warnings = [];
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      payload: { value: payload },
      warnings: ['payload_object_expected'],
    };
  }

  const normalized: Record<string, unknown> = {
    ...payload,
  };

  for (const key of ['title', 'summary', 'action', 'detail']) {
    if (normalized[key] != null) {
      if (typeof normalized[key] !== 'string') warnings.push(`${key}_coerced_to_string`);
      normalized[key] = String(normalized[key]).trim();
    }
  }

  if (normalized.details != null) {
    if (!Array.isArray(normalized.details)) {
      warnings.push('details_coerced_to_array');
      normalized.details = [normalized.details];
    }
    normalized.details = (normalized.details as unknown[])
      .map((line: unknown) => String(line || '').trim())
      .filter(Boolean);
  }

  if (normalized.links != null) {
    if (!Array.isArray(normalized.links)) {
      warnings.push('links_coerced_to_array');
      normalized.links = [normalized.links];
    }
    normalized.links = (normalized.links as unknown[])
      .map((link: unknown): PayloadLink | null => {
        if (!link) return null;
        if (typeof link === 'string') {
          warnings.push('link_string_coerced_to_object');
          return { label: link.trim(), href: '' };
        }
        if (typeof link !== 'object') {
          warnings.push('link_invalid_dropped');
          return null;
        }
        const linkRecord = link as Record<string, unknown>;
        return {
          label: String(linkRecord.label || '').trim(),
          href: String(linkRecord.href || '').trim(),
        };
      })
      .filter((link): link is PayloadLink => Boolean(link && link.label));
  }

  return {
    payload: normalized,
    warnings,
  };
}

export function normalizePayload(payload: unknown = null): NormalizedPayload {
  const validated = validatePayloadSchema(payload);
  if (validated.warnings.length > 0) {
    console.warn(`[reporting-hub] payload normalized with warnings: ${validated.warnings.join(', ')}`);
  }
  return validated.payload;
}

export function buildEventPayload({
  title = '',
  summary = '',
  details = [],
  action = '',
  links = [],
  detail = '',
  extra = {},
}: {
  title?: string;
  summary?: string;
  details?: string[];
  action?: string;
  links?: PayloadLink[];
  detail?: string;
  extra?: Record<string, unknown>;
} = {}): NormalizedPayload {
  return normalizePayload({
    title,
    summary,
    details,
    action,
    links,
    detail,
    ...extra,
  });
}

function getDefaultCooldownMs(alertLevel: number): number {
  if (alertLevel >= 4) return 0;
  if (alertLevel >= 3) return 60_000;
  if (alertLevel >= 2) return 10 * 60_000;
  return 30 * 60_000;
}

function getKstHour(): number {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCHours();
}

function buildPolicyKey(channel: string, normalized: NormalizedEvent, policy: DeliveryPolicy = {}): string {
  if (policy.key) return String(policy.key);
  return [
    channel,
    normalized.team,
    normalized.from_bot,
    normalized.event_type,
    normalized.alert_level,
    normalized.message,
  ].join('::');
}

function resolvePolicy(channel: string, normalized: NormalizedEvent, policy: DeliveryPolicy = {}) {
  return {
    dedupe: policy.dedupe !== false,
    cooldownMs: Number.isFinite(Number(policy.cooldownMs))
      ? Number(policy.cooldownMs)
      : getDefaultCooldownMs(normalized.alert_level),
    quietHours: policy.quietHours || null,
    channel,
  };
}

function shouldQuietHoursSuppress(normalized: NormalizedEvent, quietHours: DeliveryPolicy['quietHours']): boolean {
  if (!quietHours) return false;
  const maxAlertLevel = Number.isFinite(Number(quietHours.maxAlertLevel))
    ? Number(quietHours.maxAlertLevel)
    : 2;
  if (normalized.alert_level > maxAlertLevel) return false;

  const hour = quietHours.timezone === 'KST' || !quietHours.timezone
    ? getKstHour()
    : new Date().getHours();
  const startHour = Number.isFinite(Number(quietHours.startHour)) ? Number(quietHours.startHour) : 23;
  const endHour = Number.isFinite(Number(quietHours.endHour)) ? Number(quietHours.endHour) : 8;
  const inQuietHours = startHour > endHour
    ? hour >= startHour || hour < endHour
    : hour >= startHour && hour < endHour;
  return inQuietHours;
}

function evaluateDeliveryPolicy(channel: string, normalized: NormalizedEvent, policy: DeliveryPolicy = {}): PolicyDecision {
  const resolved = resolvePolicy(channel, normalized, policy);
  if (shouldQuietHoursSuppress(normalized, resolved.quietHours)) {
    return { allowed: false, reason: 'quiet_hours', policy: resolved };
  }
  if (!resolved.dedupe || resolved.cooldownMs <= 0) {
    return { allowed: true, reason: 'allowed', policy: resolved };
  }

  const key = buildPolicyKey(channel, normalized, policy);
  const now = Date.now();
  const prev = DELIVERY_STATE.get(key);
  if (prev && now - prev.sentAt < resolved.cooldownMs) {
    return {
      allowed: false,
      reason: 'deduped',
      policy: resolved,
      dedupeKey: key,
      retryAfterMs: resolved.cooldownMs - (now - prev.sentAt),
    };
  }
  DELIVERY_STATE.set(key, { sentAt: now });
  return { allowed: true, reason: 'allowed', policy: resolved, dedupeKey: key };
}

export function normalizeEvent({
  from_bot,
  team = 'general',
  event_type = 'report',
  alert_level = 2,
  message = '',
  payload = null,
}: {
  from_bot?: string;
  team?: string;
  event_type?: string;
  alert_level?: number;
  message?: string;
  payload?: unknown;
} = {}): NormalizedEvent {
  const validated = validatePayloadSchema(payload);
  if (validated.warnings.length > 0) {
    console.warn(`[reporting-hub] payload normalized with warnings: ${validated.warnings.join(', ')}`);
  }
  const normalized = {
    from_bot: String(from_bot || 'unknown'),
    team: String(team || 'general'),
    event_type: String(event_type || 'report'),
    alert_level: Number.isFinite(Number(alert_level)) ? Number(alert_level) : 2,
    message: normalizeMessageText(message),
    payload: validated.payload,
  };
  recordPayloadWarnings(normalized, validated.warnings);
  return normalized;
}

/**
 * @deprecated Legacy orchestrator queue rail. Prefer webhook, telegram, RAG,
 * or n8n targets for current runtime fanout.
 */
export async function publishToQueue({
  pgPool,
  schema = 'claude',
  table = 'mainbot_queue',
  event,
  policy,
}: QueuePublisherInput) {
  const normalized = normalizeEvent(event);
  recordLegacyQueueUsage(normalized, schema, table);
  const decision = evaluateDeliveryPolicy('queue', normalized, policy);
  if (!decision.allowed) {
    return {
      ok: true,
      skipped: true,
      reason: decision.reason,
      channel: 'queue',
      event: normalized,
    };
  }
  try {
    await pgPool.run(schema, `
      INSERT INTO ${table} (from_bot, team, event_type, alert_level, message, payload)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      normalized.from_bot,
      normalized.team,
      normalized.event_type,
      normalized.alert_level,
      normalized.message,
      normalized.payload ? JSON.stringify(normalized.payload) : null,
    ]);
    return { ok: true, channel: 'queue', event: normalized };
  } catch (error) {
    console.warn(`[reporting-hub] queue publish failed: ${(error as Error).message}`);
    return { ok: false, channel: 'queue', event: normalized, error: (error as Error).message };
  }
}

export async function publishToWebhook({
  event,
  policy,
}: {
  event: EventInput;
  policy?: DeliveryPolicy;
}) {
  const normalized = normalizeEvent(event);
  const decision = evaluateDeliveryPolicy('webhook', normalized, policy);
  if (!decision.allowed) {
    return {
      ok: true,
      skipped: true,
      reason: decision.reason,
      channel: 'webhook',
      event: normalized,
    };
  }
  try {
    const result = await openclawClient.postAlarm({
      message: normalized.message,
      team: normalized.team,
      alertLevel: normalized.alert_level,
      fromBot: normalized.from_bot,
    });
    return {
      ok: result.ok,
      channel: 'webhook',
      event: normalized,
      status: result.status,
      body: result.body,
      error: result.error,
    };
  } catch (error) {
    console.warn(`[reporting-hub] webhook publish failed: ${(error as Error).message}`);
    return { ok: false, channel: 'webhook', event: normalized, error: (error as Error).message };
  }
}

export async function publishToTelegram({
  sender,
  topicTeam,
  event,
  prefix = '',
  criticalMode = 'both',
  policy,
}: TelegramPublisherInput) {
  const normalized = normalizeEvent(event);
  const decision = evaluateDeliveryPolicy('telegram', normalized, policy);
  if (!decision.allowed) {
    return {
      ok: true,
      skipped: true,
      reason: decision.reason,
      channel: 'telegram',
      event: normalized,
    };
  }
  const finalMessage = `${prefix || ''}${normalized.message}`.trim();

  try {
    const ok = normalized.alert_level >= 3
      ? (criticalMode === 'team_only'
          ? await sender.send(topicTeam, finalMessage)
          : await sender.sendCritical(topicTeam, finalMessage))
      : await sender.send(topicTeam, finalMessage);
    return { ok: Boolean(ok), channel: 'telegram', event: normalized };
  } catch (error) {
    console.warn(`[reporting-hub] telegram publish failed: ${(error as Error).message}`);
    return { ok: false, channel: 'telegram', event: normalized, error: (error as Error).message };
  }
}

export async function publishToTelegramApi({
  token,
  chatId,
  threadId = null,
  event,
  parseMode = 'HTML',
  replyMarkup = null,
  disableWebPagePreview = true,
  policy,
}: TelegramApiPublisherInput) {
  const normalized = normalizeEvent(event);
  const decision = evaluateDeliveryPolicy('telegram', normalized, policy);
  if (!decision.allowed) {
    return {
      ok: true,
      skipped: true,
      reason: decision.reason,
      channel: 'telegram_api',
      event: normalized,
    };
  }
  if (!token || !chatId) {
    return { ok: false, channel: 'telegram_api', event: normalized, error: 'missing_telegram_credentials' };
  }

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: normalized.message,
    parse_mode: parseMode,
    disable_web_page_preview: disableWebPagePreview,
  };
  if (threadId) body.message_thread_id = threadId;
  if (replyMarkup) body.reply_markup = replyMarkup;

  try {
    for (let attempt = 1; attempt <= TELEGRAM_API_RETRY_ATTEMPTS; attempt += 1) {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.ok) {
        return { ok: true, channel: 'telegram_api', event: normalized };
      }
      if (res.status === 429 && attempt < TELEGRAM_API_RETRY_ATTEMPTS) {
        const delayMs = resolveTelegramRetryDelayMs(res, data, 3000);
        console.warn(`[reporting-hub] telegram api 429 — ${delayMs}ms 후 재시도`);
        await sleep(delayMs);
        continue;
      }
      return {
        ok: false,
        channel: 'telegram_api',
        event: normalized,
        error: data?.description || `telegram_api_status_${res.status}`,
      };
    }
    return { ok: false, channel: 'telegram_api', event: normalized, error: 'telegram_retry_exhausted' };
  } catch (error) {
    console.warn(`[reporting-hub] telegram api publish failed: ${(error as Error).message}`);
    return { ok: false, channel: 'telegram_api', event: normalized, error: (error as Error).message };
  }
}

export async function publishToRag({
  ragStore,
  collection = 'operations',
  sourceBot,
  event,
  metadata = {},
  contentBuilder,
  policy,
}: RagPublisherInput) {
  const normalized = normalizeEvent(event);
  const decision = evaluateDeliveryPolicy('rag', normalized, policy);
  if (!decision.allowed) {
    return {
      ok: true,
      skipped: true,
      reason: decision.reason,
      channel: 'rag',
      event: normalized,
    };
  }
  if (!ragStore || typeof ragStore.store !== 'function') {
    return { ok: false, channel: 'rag', event: normalized, error: 'missing_rag_store' };
  }

  const content = typeof contentBuilder === 'function'
    ? contentBuilder(normalized)
    : normalized.message;

  try {
    const id = await ragStore.store(
      collection,
      content,
      {
        team: normalized.team,
        event_type: normalized.event_type,
        alert_level: normalized.alert_level,
        from_bot: normalized.from_bot,
        ...(normalized.payload && typeof normalized.payload === 'object' ? normalized.payload : {}),
        ...metadata,
      },
      sourceBot || normalized.from_bot,
    );
    return { ok: true, channel: 'rag', event: normalized, id };
  } catch (error) {
    console.warn(`[reporting-hub] rag publish failed: ${(error as Error).message}`);
    return { ok: false, channel: 'rag', event: normalized, error: (error as Error).message };
  }
}

export async function publishToN8n({
  circuitName,
  webhookCandidates,
  healthUrl,
  event,
  bodyBuilder,
  directResult = { ok: false, source: 'direct_bypass' },
  policy,
}: N8nPublisherInput) {
  const normalized = normalizeEvent(event);
  const decision = evaluateDeliveryPolicy('n8n', normalized, policy);
  if (!decision.allowed) {
    return {
      ok: true,
      skipped: true,
      reason: decision.reason,
      channel: 'n8n',
      event: normalized,
    };
  }
  if (!Array.isArray(webhookCandidates) || webhookCandidates.length === 0) {
    return { ok: false, channel: 'n8n', event: normalized, error: 'missing_webhook_candidates' };
  }

  try {
    const result = await runWithN8nFallback({
      circuitName: circuitName || `reporting:${normalized.team}:${normalized.event_type}`,
      webhookCandidates,
      healthUrl,
      body: typeof bodyBuilder === 'function' ? bodyBuilder(normalized) : normalized,
      directRunner: async () => directResult,
      logger: console,
    });
    return {
      ok: Boolean(result?.ok || result?.source === 'n8n'),
      channel: 'n8n',
      event: normalized,
      result,
    };
  } catch (error) {
    console.warn(`[reporting-hub] n8n publish failed: ${(error as Error).message}`);
    return { ok: false, channel: 'n8n', event: normalized, error: (error as Error).message };
  }
}

/** @param {any} [input] */
export async function publishEventPipeline({
  event,
  targets = [],
  policy = {},
}: any = {}) {
  const normalized = normalizeEvent(event);
  const results = [];

  for (const target of targets) {
    if (!target || !target.type) continue;

    switch (target.type) {
      case 'queue':
        results.push(await publishToQueue({
          pgPool: target.pgPool,
          schema: target.schema,
          table: target.table,
          event: normalized,
          policy: { ...policy, ...(target.policy || {}) },
        }));
        break;
      case 'telegram':
        results.push(await publishToTelegram({
          sender: target.sender,
          topicTeam: target.topicTeam,
          event: normalized,
          prefix: target.prefix,
          criticalMode: target.criticalMode,
          policy: { ...policy, ...(target.policy || {}) },
        }));
        break;
      case 'telegram_api':
        results.push(await publishToTelegramApi({
          token: target.token,
          chatId: target.chatId,
          threadId: target.threadId,
          event: normalized,
          parseMode: target.parseMode,
          replyMarkup: target.replyMarkup,
          disableWebPagePreview: target.disableWebPagePreview,
          policy: { ...policy, ...(target.policy || {}) },
        }));
        break;
      case 'rag':
        results.push(await publishToRag({
          ragStore: target.ragStore,
          collection: target.collection,
          sourceBot: target.sourceBot,
          event: normalized,
          metadata: target.metadata,
          contentBuilder: target.contentBuilder,
          policy: { ...policy, ...(target.policy || {}) },
        }));
        break;
      case 'n8n':
        results.push(await publishToN8n({
          circuitName: target.circuitName,
          webhookCandidates: target.webhookCandidates,
          healthUrl: target.healthUrl,
          event: normalized,
          bodyBuilder: target.bodyBuilder,
          directResult: target.directResult,
          policy: { ...policy, ...(target.policy || {}) },
        }));
        break;
      default:
        results.push({
          ok: false,
          channel: String(target.type),
          event: normalized,
          error: 'unsupported_target',
        });
        break;
    }
  }

  return {
    ok: results.every((item) => item.ok),
    event: normalized,
    results,
  };
}

export function buildSnippetEvent({
  from_bot = 'reporting-hub',
  team = 'general',
  event_type = 'report',
  alert_level = 2,
  title = '',
  lines = [],
  detailHint = '',
  payload = null,
}: {
  from_bot?: string;
  team?: string;
  event_type?: string;
  alert_level?: number;
  title?: string;
  lines?: unknown[];
  detailHint?: string;
  payload?: unknown;
} = {}): SnippetEvent {
  const normalized = normalizeEvent({
    from_bot,
    team,
    event_type,
    alert_level,
    message: title,
    payload,
  });
  return {
    ...normalized,
    title: String(title || normalized.message || '').trim(),
    lines: (lines || []).map((line: unknown) => String(line || '').trim()).filter(Boolean),
    detailHint: String(detailHint || '').trim(),
  };
}

export function renderSnippetEvent(event: EventInput | SnippetEvent | null | undefined): string {
  if (!event) return '';
  const normalized = buildSnippetEvent(event);
  const lines = [normalized.title];
  if (normalized.lines.length > 0) {
    lines.push('');
    for (const line of normalized.lines) lines.push(`  • ${line}`);
  }
  if (normalized.detailHint) {
    lines.push('');
    lines.push(`상세 확인: ${normalized.detailHint}`);
  }
  return lines.join('\n');
}

export function buildNoticeEvent({
  from_bot = 'reporting-hub',
  team = 'general',
  event_type = 'alert',
  alert_level = 2,
  title = '',
  summary = '',
  details = [],
  action = '',
  actionLabel = '조치',
  footer = '',
  payload = null,
}: {
  from_bot?: string;
  team?: string;
  event_type?: string;
  alert_level?: number;
  title?: string;
  summary?: string;
  details?: unknown[];
  action?: string;
  actionLabel?: string;
  footer?: string;
  payload?: unknown;
} = {}): NoticeEvent {
  const normalized = normalizeEvent({
    from_bot,
    team,
    event_type,
    alert_level,
    message: title || summary,
    payload,
  });
  return {
    ...normalized,
    title: String(title || '').trim(),
    summary: String(summary || '').trim(),
    details: (details || []).map((line: unknown) => String(line || '').trim()).filter(Boolean),
    action: String(action || '').trim(),
    actionLabel: String(actionLabel || '조치').trim(),
    footer: String(footer || '').trim(),
  };
}

export function renderNoticeEvent(event: EventInput | NoticeEvent | null | undefined): string {
  if (!event) return '';
  const normalized = buildNoticeEvent(event);
  const alertLevel = normalized.alert_level as AlertLevel;
  const levelLabel = ALERT_LEVEL_LABELS[alertLevel] || '알림';
  const levelIcon = ALERT_LEVEL_ICONS[alertLevel] || 'ℹ️';
  const title = compactNoticeTitle(normalized.title);
  const summary = compactLine(normalized.summary);
  const lines = [`${levelIcon} ${levelLabel}${title ? ` · ${title}` : ''}`];

  if (summary && summary !== title) lines.push(`요약: ${summary}`);
  for (const detail of compactLines(normalized.details, MOBILE_DETAIL_LIMIT)) {
    lines.push(detail);
  }
  if (normalized.action) {
    lines.push(`${normalized.actionLabel}: ${compactLine(normalized.action)}`);
  }
  if (normalized.footer) {
    lines.push(compactLine(normalized.footer));
  }
  return lines.join('\n').trim();
}

export function buildReportEvent({
  from_bot = 'reporting-hub',
  team = 'general',
  event_type = 'report',
  alert_level = 1,
  title = '',
  summary = '',
  sections = [],
  footer = '',
  payload = null,
}: {
  from_bot?: string;
  team?: string;
  event_type?: string;
  alert_level?: number;
  title?: string;
  summary?: string;
  sections?: Array<{ title?: string; lines?: unknown[] }>;
  footer?: string;
  payload?: unknown;
} = {}): ReportEvent {
  const normalized = normalizeEvent({
    from_bot,
    team,
    event_type,
    alert_level,
    message: title || summary,
    payload,
  });
  return {
    ...normalized,
    title: String(title || '').trim(),
    summary: String(summary || '').trim(),
    sections: (sections || []).map((section): ReportSection => ({
      title: String(section?.title || '').trim(),
      lines: (section?.lines || []).map((line: unknown) => String(line || '').trim()).filter(Boolean),
    })).filter((section) => section.title || section.lines.length > 0),
    footer: String(footer || '').trim(),
  };
}

export function renderReportEvent(event: EventInput | ReportEvent | null | undefined): string {
  if (!event) return '';
  const normalized = buildReportEvent(event);
  const lines = [];
  if (normalized.title) lines.push(compactLine(normalized.title, 52));
  if (normalized.summary) lines.push(compactLine(normalized.summary));
  for (const section of normalized.sections) {
    const title = compactSectionTitle(section.title);
    if (title) lines.push(title);
    for (const line of compactLines(section.lines, MOBILE_SECTION_LINE_LIMIT)) {
      lines.push(`• ${line}`);
    }
  }
  if (normalized.footer) {
    lines.push(compactLine(normalized.footer));
  }
  return lines.join('\n').trim();
}

export function parseEventPayload(payload: unknown): NormalizedPayload {
  if (!payload) return null;
  if (typeof payload === 'object') return normalizePayload(payload);
  if (typeof payload !== 'string') return null;
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === 'object' ? normalizePayload(parsed) : null;
  } catch {
    return null;
  }
}

export function getEventHeadline(event: { payload?: unknown; message?: string | null } | null | undefined): string {
  const payload = parseEventPayload(event?.payload);
  const fromPayload = [
    payload?.title,
    payload?.summary,
    payload?.detail,
  ].find((value) => typeof value === 'string' && value.trim());
  if (fromPayload) return String(fromPayload).trim();

  const message = String(event?.message || '').trim();
  if (!message) return '';
  return message.split('\n').map((line) => line.trim()).find(Boolean) || '';
}

export function getEventDetailLines(event: { payload?: unknown; message?: string | null } | null | undefined): string[] {
  const payload = parseEventPayload(event?.payload);
  const payloadDetails = [];
  if (Array.isArray(payload?.details)) {
    payloadDetails.push(...payload.details.map((line) => String(line || '').trim()).filter(Boolean));
  }
  if (payloadDetails.length > 0) {
    return compactLines(payloadDetails, MOBILE_DETAIL_LIMIT);
  }
  const messageLines = String(event?.message || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const headline = getEventHeadline(event);
  const filteredMessageLines = messageLines.filter((line, index) => !(index === 0 && line === headline));
  return compactLines(filteredMessageLines, MOBILE_DETAIL_LIMIT);
}

export function getEventAction(event: { payload?: unknown } | null | undefined): string {
  const payload = parseEventPayload(event?.payload);
  if (typeof payload?.action === 'string' && payload.action.trim()) {
    return payload.action.trim();
  }
  return '';
}

export function getEventLinkLines(event: { payload?: unknown } | null | undefined): string[] {
  const payload = parseEventPayload(event?.payload);
  if (!Array.isArray(payload?.links)) return [];
  return payload.links
    .map((link: PayloadLink) => {
      const label = String(link?.label || '').trim();
      const href = String(link?.href || '').trim();
      if (!label) return '';
      return href ? `${label}: ${href}` : label;
    })
    .filter(Boolean);
}

/**
 * @deprecated 2026-04-05 알람 전달은 postAlarm()으로 통일됨.
 * publishToQueue, publishToRag 등 큐/RAG 용도는 유지.
 * 텔레그램 알람 목적으로는 사용하지 말 것.
 * @param {any} [input]
 */
export function buildSeverityTargets({
  event,
  pgPool,
  schema = 'claude',
  table,
  sender,
  topicTeam,
  telegramPrefix = '',
  includeQueue = false,
  includeTelegram = true,
  includeN8n = true,
  criticalTelegramMode = 'both',
  criticalWebhookUrl = DEFAULT_CRITICAL_WEBHOOK_URL,
}: {
  event?: EventInput;
  pgPool?: QueuePublisherInput['pgPool'];
  schema?: string;
  table?: string;
  sender?: TelegramPublisherInput['sender'];
  topicTeam?: string;
  telegramPrefix?: string;
  includeQueue?: boolean;
  includeTelegram?: boolean;
  includeN8n?: boolean;
  criticalTelegramMode?: string;
  criticalWebhookUrl?: string;
} = {}) {
  const normalized = normalizeEvent(event);
  const targets = [];

  if (includeQueue && pgPool) {
    targets.push({
      type: 'queue',
      pgPool,
      schema,
      table,
    });
  }

  const wantsTelegram = includeTelegram && sender && topicTeam && (
    normalized.event_type === 'alert' ||
    normalized.alert_level >= 2 ||
    normalized.event_type === 'accuracy_alert'
  );
  if (wantsTelegram) {
    targets.push({
      type: 'telegram',
      sender,
      topicTeam,
      prefix: telegramPrefix,
      criticalMode: criticalTelegramMode,
    });
  }

  if (includeN8n && normalized.alert_level >= 4 && criticalWebhookUrl) {
    targets.push({
      type: 'n8n',
      webhookCandidates: [criticalWebhookUrl],
      healthUrl: 'http://127.0.0.1:5678/healthz',
      bodyBuilder: (payloadEvent: NormalizedEvent) => ({
        severity: 'critical',
        service: payloadEvent.team || payloadEvent.from_bot,
        message: payloadEvent.message,
        detail: payloadEvent.payload?.detail || payloadEvent.payload?.summary || '',
        source_bot: payloadEvent.from_bot,
        event_type: payloadEvent.event_type,
      }),
      policy: {
        dedupe: false,
      },
    });
  }

  return targets;
}
