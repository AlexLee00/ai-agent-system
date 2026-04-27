'use strict';

const crypto = require('crypto');

function normalizeText(value: unknown, fallback = ''): string {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function scrubDynamicText(value: string): string {
  return normalizeText(value)
    .toLowerCase()
    .replace(/bearer\s+[a-z0-9._~+/=-]+/gi, 'bearer [token]')
    .replace(/[a-z0-9_-]{16,}\.[a-z0-9._-]{16,}/gi, '[jwt]')
    .replace(/[a-f0-9]{8,}-[a-f0-9]{4,}-[a-f0-9]{4,}-[a-f0-9]{4,}-[a-f0-9]{12,}/gi, '[uuid]')
    .replace(/\b\d{10,}\b/g, '[id]')
    .replace(/\b\d{4}-\d{2}-\d{2}[t\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?\b/g, '[timestamp]')
    .replace(/\b[a-z0-9]{3,12}\/(?:usdt|usd|btc|eth|krw)\b/gi, '[symbol]')
    .replace(/\s+/g, ' ')
    .trim();
}

function payloadText(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const record = payload as Record<string, unknown>;
  const parts = [
    record.error,
    record.code,
    record.reason,
    record.provider,
    record.provider_error,
    record.failure_kind,
    record.failureKind,
    record.event_type,
  ];
  return parts.map((item) => normalizeText(item)).filter(Boolean).join(' ');
}

function classifyClusterFamily(corpus: string): string {
  if (/provider_cooldown|cooldown|rate[_\s-]?limit|429/.test(corpus)) return 'llm_provider_cooldown';
  if (/oauth|refresh[_\s-]?token|access[_\s-]?token|authorization|permission|권한/.test(corpus)) return 'oauth';
  if (/telegram|topic|message[_\s-]?thread|chat_id|sendmessage|토픽|텔레그램/.test(corpus)) return 'telegram_routing';
  if (/postgres|database|db_|schema|sql|relation .* does not exist|deadlock/.test(corpus)) return 'database';
  if (/binance|orderid|clientorderid|reconcile|filled|manual_reconcile/.test(corpus)) return 'broker_order_reconcile';
  if (/queue|claim|lease|stale|preparing/.test(corpus)) return 'queue_lifecycle';
  if (/openclaw|legacy[_\s-]?gateway|18789/.test(corpus)) return 'retired_gateway_regression';
  if (/발행 대기|미발행|naver[_\s-]?publish|네이버 발행|blog[_\s-]?publish|ready 상태/.test(corpus)) return 'blog_publish';
  return 'generic';
}

export function buildAlarmClusterKey({
  team,
  fromBot,
  eventType,
  title,
  message,
  payload,
}: {
  team?: unknown;
  fromBot?: unknown;
  eventType?: unknown;
  title?: unknown;
  message?: unknown;
  payload?: unknown;
}): string {
  const normalizedTeam = scrubDynamicText(normalizeText(team, 'general'));
  const bot = scrubDynamicText(normalizeText(fromBot, 'unknown')).slice(0, 48);
  const event = scrubDynamicText(normalizeText(eventType, 'hub_alarm')).slice(0, 80);
  const corpus = scrubDynamicText([
    title,
    message,
    payloadText(payload),
  ].map((item) => normalizeText(item)).join(' '));
  const family = classifyClusterFamily(`${event} ${corpus}`);
  const signatureSource = family === 'generic'
    ? `${event}|${corpus.slice(0, 180)}`
    : `${family}|${event}|${bot}`;
  const digest = crypto.createHash('sha1').update(signatureSource).digest('hex').slice(0, 12);
  return [normalizedTeam || 'general', family, digest].join('|');
}

module.exports = {
  buildAlarmClusterKey,
};

