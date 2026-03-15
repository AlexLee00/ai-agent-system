'use strict';

const { runWithN8nFallback } = require('./n8n-runner');

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

function normalizeEvent({
  from_bot,
  team = 'general',
  event_type = 'report',
  alert_level = 2,
  message = '',
  payload = null,
} = {}) {
  return {
    from_bot: String(from_bot || 'unknown'),
    team: String(team || 'general'),
    event_type: String(event_type || 'report'),
    alert_level: Number.isFinite(Number(alert_level)) ? Number(alert_level) : 2,
    message: String(message || '').trim(),
    payload: payload == null ? null : payload,
  };
}

async function publishToQueue({
  pgPool,
  schema = 'claude',
  table = 'mainbot_queue',
  event,
}) {
  const normalized = normalizeEvent(event);
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
    console.warn(`[reporting-hub] queue publish failed: ${error.message}`);
    return { ok: false, channel: 'queue', event: normalized, error: error.message };
  }
}

async function publishToTelegram({
  sender,
  topicTeam,
  event,
  prefix = '',
}) {
  const normalized = normalizeEvent(event);
  const finalMessage = `${prefix || ''}${normalized.message}`.trim();

  try {
    const ok = normalized.alert_level >= 3
      ? await sender.sendCritical(topicTeam, finalMessage)
      : await sender.send(topicTeam, finalMessage);
    return { ok: Boolean(ok), channel: 'telegram', event: normalized };
  } catch (error) {
    console.warn(`[reporting-hub] telegram publish failed: ${error.message}`);
    return { ok: false, channel: 'telegram', event: normalized, error: error.message };
  }
}

async function publishToRag({
  ragStore,
  collection = 'operations',
  sourceBot,
  event,
  metadata = {},
  contentBuilder,
}) {
  const normalized = normalizeEvent(event);
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
    console.warn(`[reporting-hub] rag publish failed: ${error.message}`);
    return { ok: false, channel: 'rag', event: normalized, error: error.message };
  }
}

async function publishToN8n({
  circuitName,
  webhookCandidates,
  healthUrl,
  event,
  bodyBuilder,
  directResult = { ok: false, source: 'direct_bypass' },
}) {
  const normalized = normalizeEvent(event);
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
    console.warn(`[reporting-hub] n8n publish failed: ${error.message}`);
    return { ok: false, channel: 'n8n', event: normalized, error: error.message };
  }
}

async function publishEventPipeline({
  event,
  targets = [],
} = {}) {
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
        }));
        break;
      case 'telegram':
        results.push(await publishToTelegram({
          sender: target.sender,
          topicTeam: target.topicTeam,
          event: normalized,
          prefix: target.prefix,
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

function buildSnippetEvent({
  from_bot = 'reporting-hub',
  team = 'general',
  event_type = 'report',
  alert_level = 2,
  title = '',
  lines = [],
  detailHint = '',
  payload = null,
} = {}) {
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
    lines: (lines || []).map((line) => String(line || '').trim()).filter(Boolean),
    detailHint: String(detailHint || '').trim(),
  };
}

function renderSnippetEvent(event) {
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

function buildNoticeEvent({
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
} = {}) {
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
    details: (details || []).map((line) => String(line || '').trim()).filter(Boolean),
    action: String(action || '').trim(),
    actionLabel: String(actionLabel || '조치').trim(),
    footer: String(footer || '').trim(),
  };
}

function renderNoticeEvent(event) {
  if (!event) return '';
  const normalized = buildNoticeEvent(event);
  const levelLabel = ALERT_LEVEL_LABELS[normalized.alert_level] || '알림';
  const levelIcon = ALERT_LEVEL_ICONS[normalized.alert_level] || 'ℹ️';
  const lines = [
    `${levelIcon} ${levelLabel}`,
  ];

  if (normalized.title) {
    lines.push('');
    lines.push(normalized.title);
  }
  if (normalized.summary) {
    lines.push('');
    lines.push(`요약: ${normalized.summary}`);
  }
  for (const detail of normalized.details) {
    lines.push(detail);
  }
  if (normalized.action) {
    lines.push(`${normalized.actionLabel}: ${normalized.action}`);
  }
  if (normalized.footer) {
    lines.push('');
    lines.push(normalized.footer);
  }
  return lines.join('\n').trim();
}

function buildReportEvent({
  from_bot = 'reporting-hub',
  team = 'general',
  event_type = 'report',
  alert_level = 1,
  title = '',
  summary = '',
  sections = [],
  footer = '',
  payload = null,
} = {}) {
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
    sections: (sections || []).map((section) => ({
      title: String(section?.title || '').trim(),
      lines: (section?.lines || []).map((line) => String(line || '').trim()).filter(Boolean),
    })).filter((section) => section.title || section.lines.length > 0),
    footer: String(footer || '').trim(),
  };
}

function renderReportEvent(event) {
  if (!event) return '';
  const normalized = buildReportEvent(event);
  const lines = [];
  if (normalized.title) lines.push(normalized.title);
  if (normalized.summary) {
    if (lines.length > 0) lines.push('');
    lines.push(normalized.summary);
  }
  for (const section of normalized.sections) {
    if (lines.length > 0) lines.push('');
    if (section.title) lines.push(section.title);
    for (const line of section.lines) {
      lines.push(`  ${line}`);
    }
  }
  if (normalized.footer) {
    if (lines.length > 0) lines.push('');
    lines.push(normalized.footer);
  }
  return lines.join('\n').trim();
}

module.exports = {
  normalizeEvent,
  publishToQueue,
  publishToTelegram,
  publishToRag,
  publishToN8n,
  publishEventPipeline,
  buildSnippetEvent,
  renderSnippetEvent,
  buildNoticeEvent,
  renderNoticeEvent,
  buildReportEvent,
  renderReportEvent,
};
