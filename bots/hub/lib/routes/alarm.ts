const eventLake = require('../../../../packages/core/lib/event-lake');
const telegramSender = require('../../../../packages/core/lib/telegram-sender');
const { classifyAlarmTypeWithConfidence, isExplicitHumanEscalation } = require('../alarm/policy');
const { classifyAlarmWithLLM } = require('../alarm/classify-alarm-llm');
const { interpretAlarm } = require('../alarm/alarm-interpreter-router');
const { enrichAlarm } = require('../alarm/alarm-enrichment');
const { runRoundtable, shouldTriggerRoundtable } = require('../alarm/alarm-roundtable-engine');
const { ensureAlarmAutoDevDocument } = require('../alarm/auto-dev-incident');
const { buildAlarmClusterKey } = require('../alarm/cluster');
const {
  formatAlarmNotification,
  formatAutoRepairResultMessage,
  resolveAlarmDeliveryTeam,
} = require('../alarm/templates');
const { buildAlarmReadinessSnapshot } = require('../alarm/readiness');
const {
  applyAlarmSuppressionProposals,
  buildAlarmSuppressionProposals,
} = require('../../scripts/alarm-suppression-proposals.ts');
const { findMatchingAlarmSuppressionRule } = require('../alarm/suppression-rules.ts');

const defaultAlarmEventLake = {
  findRecentDuplicateAlarm: (...args: any[]) => eventLake.findRecentDuplicateAlarm(...args),
  record: (...args: any[]) => eventLake.record(...args),
};
let alarmEventLake = defaultAlarmEventLake;

const defaultAlarmRouteHooks = {
  classifyAlarmWithLLM,
  interpretAlarm,
  enrichAlarm,
  runRoundtable,
  shouldTriggerRoundtable,
  ensureAlarmAutoDevDocument,
};
let alarmRouteHooks = defaultAlarmRouteHooks;

const defaultAlarmDb = {
  query: (...args: any[]) => pgPool.query(...args),
  get: (...args: any[]) => pgPool.get(...args),
  run: (...args: any[]) => pgPool.run(...args),
};
let alarmDb = defaultAlarmDb;

export function _testOnly_setAlarmRouteDbMocks(overrides: Partial<typeof defaultAlarmDb> = {}) {
  alarmDb = { ...defaultAlarmDb, ...overrides };
}

export function _testOnly_resetAlarmRouteDbMocks() {
  alarmDb = defaultAlarmDb;
}

export function _testOnly_setAlarmEventLakeMocks(overrides: Partial<typeof defaultAlarmEventLake> = {}) {
  alarmEventLake = { ...defaultAlarmEventLake, ...overrides };
}

export function _testOnly_resetAlarmEventLakeMocks() {
  alarmEventLake = defaultAlarmEventLake;
}

export function _testOnly_setAlarmRouteHooks(overrides: Partial<typeof defaultAlarmRouteHooks> = {}) {
  alarmRouteHooks = { ...defaultAlarmRouteHooks, ...overrides };
}

export function _testOnly_resetAlarmRouteHooks() {
  alarmRouteHooks = defaultAlarmRouteHooks;
}

function alarmsDisabled(): boolean {
  const raw = String(process.env.HUB_ALARMS_DISABLED || process.env.ALERTS_DISABLED || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw);
}

type DispatchMode = 'shadow' | 'supervised' | 'autonomous';

export function getDispatchMode(): DispatchMode {
  const raw = String(process.env.HUB_ALARM_DISPATCH_MODE || '').trim().toLowerCase();
  if (raw === 'shadow') return 'shadow';
  if (raw === 'autonomous') return 'autonomous';
  return 'supervised';
}
const pgPool = require('../../../../packages/core/lib/pg-pool');

const VISIBILITY_VALUES = ['internal', 'audit_only', 'digest', 'notify', 'human_action', 'emergency'] as const;
const ACTIONABILITY_VALUES = ['none', 'auto_repair', 'needs_approval', 'needs_human'] as const;
const STATUS_VALUES = ['new', 'correlating', 'repairing', 'verified', 'exhausted'] as const;
const ALARM_TYPE_VALUES = ['work', 'report', 'error', 'critical'] as const;

type AlarmVisibility = (typeof VISIBILITY_VALUES)[number];
type AlarmActionability = (typeof ACTIONABILITY_VALUES)[number];
type AlarmStatus = (typeof STATUS_VALUES)[number];
type AlarmType = (typeof ALARM_TYPE_VALUES)[number];
type DigestRow = {
  id: number;
  team: string;
  bot_name: string;
  severity: string;
  message: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

function normalizeText(value: unknown, fallback = ''): string {
  const normalized = String(value == null ? fallback : value).trim();
  return normalized || fallback;
}

function normalizeSeverity(value: unknown): 'info' | 'warn' | 'error' | 'critical' {
  const normalized = normalizeText(value, 'info').toLowerCase();
  return ['info', 'warn', 'error', 'critical'].includes(normalized)
    ? (normalized as 'info' | 'warn' | 'error' | 'critical')
    : 'info';
}

function normalizeVisibility(value: unknown): AlarmVisibility | null {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return null;
  return VISIBILITY_VALUES.includes(normalized as AlarmVisibility)
    ? (normalized as AlarmVisibility)
    : null;
}

function normalizeActionability(value: unknown): AlarmActionability | null {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return null;
  return ACTIONABILITY_VALUES.includes(normalized as AlarmActionability)
    ? (normalized as AlarmActionability)
    : null;
}

function normalizeStatus(value: unknown): AlarmStatus | null {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return null;
  return STATUS_VALUES.includes(normalized as AlarmStatus)
    ? (normalized as AlarmStatus)
    : null;
}

function normalizeTeam(value: unknown): string {
  const normalized = normalizeText(value, 'general').toLowerCase();
  const aliases: Record<string, string> = {
    claude: 'claude',
    'claude-lead': 'claude-lead',
    investment: 'investment',
    luna: 'luna',
    reservation: 'reservation',
    ska: 'ska',
    sigma: 'sigma',
    meeting: 'meeting',
    emergency: 'emergency',
    'ops-work': 'ops-work',
    'ops-reports': 'ops-reports',
    'ops-error-resolution': 'ops-error-resolution',
    'ops-emergency': 'ops-emergency',
    blog: 'blog',
    general: 'general',
  };
  return aliases[normalized] || 'general';
}

function _parseLunaBlogRequest(message: string): { regime: string; mood: string; keywordHints: string } | null {
  if (!message.includes('루나팀 시장 급변')) return null;
  const regimeMatch = message.match(/현재 체제: (\w+)/);
  const moodMatch = message.match(/현재 체제: \w+ \(([^)]+)\)/);
  const kwMatch = message.match(/키워드 힌트: (.+)/);
  const regime = regimeMatch?.[1] || 'volatile';
  const mood = moodMatch?.[1] || '시장 변화';
  const keywordHints = kwMatch?.[1]?.trim() || '';
  return { regime, mood, keywordHints };
}

function normalizeEventType(payload: unknown, fallback = 'hub_alarm'): string {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const value = normalizeText((payload as Record<string, unknown>).event_type, fallback);
    if (value) return value.toLowerCase();
  }
  return normalizeText(fallback, 'hub_alarm').toLowerCase();
}

function buildIncidentKey({
  team,
  fromBot,
  eventType,
  title,
  message,
}: {
  team: string;
  fromBot: string;
  eventType: string;
  title: string;
  message: string;
}): string {
  const msgTop = normalizeText(message).split('\n')[0]?.slice(0, 120) || '';
  const material = [team, fromBot, eventType, title, msgTop]
    .map((value) => normalizeText(value).toLowerCase().replace(/\s+/g, '_'))
    .filter(Boolean)
    .join('|');
  return material || `${team}|${eventType}|fallback`;
}

async function recordHubAlarmClassification({
  eventId,
  classifierSource,
  alarmType,
  finalConfidence,
  ruleConfidence,
  llmConfidence,
  incidentKey,
  dispatchMode,
}: {
  eventId: number | null;
  classifierSource: string;
  alarmType: AlarmType;
  finalConfidence: number;
  ruleConfidence: number;
  llmConfidence: number | null;
  incidentKey: string;
  dispatchMode: DispatchMode;
}) {
  if (!eventId) return { ok: false, reason: 'missing_event_id' };
  try {
    await alarmDb.run('agent', `
      INSERT INTO agent.hub_alarm_classifications
        (alarm_id, classifier_source, alarm_type, confidence, rule_score, llm_score, metadata)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7::jsonb)
    `, [
      eventId,
      classifierSource,
      alarmType,
      finalConfidence,
      ruleConfidence,
      llmConfidence,
      JSON.stringify({
        incident_key: incidentKey,
        dispatch_mode: dispatchMode,
        source: 'hub_alarm_route',
      }),
    ]);
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: error?.message || 'hub_alarm_classification_record_failed' };
  }
}

async function recordHubAlarmMirror({
  team,
  fromBot,
  severity,
  alarmType,
  title,
  message,
  fingerprint,
  visibility,
  actionability,
  status,
  metadata,
}: {
  team: string;
  fromBot: string;
  severity: string;
  alarmType: AlarmType;
  title: string;
  message: string;
  fingerprint: string;
  visibility: AlarmVisibility;
  actionability: AlarmActionability;
  status: AlarmStatus;
  metadata: Record<string, unknown>;
}) {
  try {
    await alarmDb.run('agent', `
      INSERT INTO agent.hub_alarms
        (team, bot_name, severity, alarm_type, title, message, fingerprint, fingerprint_count, visibility, actionability, status, metadata)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, $10, $11::jsonb)
    `, [
      team,
      fromBot,
      severity,
      alarmType,
      title,
      message,
      fingerprint,
      visibility,
      actionability,
      status,
      JSON.stringify(metadata || {}),
    ]);
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: error?.message || 'hub_alarm_mirror_record_failed' };
  }
}

function defaultActionability({
  severity,
  visibility,
  alarmType,
  explicitHumanEscalation = false,
}: {
  severity: 'info' | 'warn' | 'error' | 'critical';
  visibility: AlarmVisibility;
  alarmType: AlarmType;
  explicitHumanEscalation?: boolean;
}): AlarmActionability {
  if (visibility === 'human_action') return 'needs_approval';
  if (visibility === 'emergency') return 'needs_human';
  if (explicitHumanEscalation && severity === 'critical') return 'needs_human';
  if (alarmType === 'critical') return 'needs_human';
  if (alarmType === 'error') return 'auto_repair';
  if (alarmType === 'work' || alarmType === 'report') return 'none';
  if (severity === 'error' || severity === 'warn') return 'auto_repair';
  return 'none';
}

function defaultVisibility({
  severity,
  actionability,
  alarmType,
  explicitHumanEscalation = false,
}: {
  severity: 'info' | 'warn' | 'error' | 'critical';
  actionability: AlarmActionability | null;
  alarmType: AlarmType;
  explicitHumanEscalation?: boolean;
}): AlarmVisibility {
  if (explicitHumanEscalation) {
    if (severity === 'critical' || actionability === 'needs_human') return 'emergency';
    return 'human_action';
  }
  if (actionability === 'needs_approval' || actionability === 'needs_human') return 'human_action';
  if (alarmType === 'critical') return 'emergency';
  if (alarmType === 'work' || alarmType === 'report') return 'notify';
  if (alarmType === 'error') return 'internal';
  return severity === 'critical' ? 'digest' : 'internal';
}

function defaultStatus({
  actionability,
  visibility,
}: {
  actionability: AlarmActionability;
  visibility: AlarmVisibility;
}): AlarmStatus {
  if (visibility === 'emergency') return 'new';
  if (actionability === 'auto_repair') return 'repairing';
  if (actionability === 'none') return 'verified';
  return 'new';
}

function shouldSendTelegramImmediately(visibility: AlarmVisibility): boolean {
  return visibility === 'notify' || visibility === 'human_action' || visibility === 'emergency';
}

function summarizeDigestMessage(team: string, rows: DigestRow[], nowIso: string): string {
  const severityCounts = {
    warn: 0,
    error: 0,
    critical: 0,
    other: 0,
  };
  const incidentMap = new Map<string, { count: number; latestAt: string }>();
  for (const row of rows) {
    const severity = normalizeText(row?.severity, '').toLowerCase();
    if (severity === 'warn') severityCounts.warn += 1;
    else if (severity === 'error') severityCounts.error += 1;
    else if (severity === 'critical') severityCounts.critical += 1;
    else severityCounts.other += 1;

    const incidentKey = normalizeText((row?.metadata as any)?.incident_key, '')
      || `${normalizeText(row?.bot_name, 'unknown')}|${normalizeText(row?.message, '').slice(0, 80)}`;
    const previous = incidentMap.get(incidentKey);
    if (!previous) {
      incidentMap.set(incidentKey, {
        count: 1,
        latestAt: normalizeText(row.created_at, nowIso),
      });
    } else {
      previous.count += 1;
      previous.latestAt = normalizeText(row.created_at, previous.latestAt);
      incidentMap.set(incidentKey, previous);
    }
  }
  const topIncidents = [...incidentMap.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5);

  const lines = [
    `[hub-digest] ${team} 알람 요약`,
    `- 대상: ${rows.length}건 (warn ${severityCounts.warn}, error ${severityCounts.error}, critical ${severityCounts.critical})`,
    `- 생성 시각: ${nowIso}`,
  ];
  if (topIncidents.length > 0) {
    lines.push('- 주요 incident:');
    for (const [incidentKey, summary] of topIncidents) {
      lines.push(`  • ${incidentKey} (${summary.count}건)`);
    }
  }
  return lines.join('\n');
}

export async function flushAlarmDigest({
  minutes = 240,
  limit = 200,
  team = '',
  dryRun = false,
}: {
  minutes?: number;
  limit?: number;
  team?: string;
  dryRun?: boolean;
} = {}) {
  const windowMinutes = Math.max(1, Number(minutes || 0) || 240);
  const rowLimit = Math.min(1000, Math.max(1, Number(limit || 0) || 200));
  const normalizedTeam = normalizeTeam(team || '');
  const nowIso = new Date().toISOString();
  const claimId = `digest_claim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const claimLeaseMinutes = Math.max(1, Number(process.env.HUB_ALARM_DIGEST_CLAIM_LEASE_MINUTES || 15) || 15);
  const params: unknown[] = [windowMinutes];
  const conditions = [
    `event_type = 'hub_alarm'`,
    `created_at >= NOW() - ($1::int * INTERVAL '1 minute')`,
    `metadata->>'visibility' = 'digest'`,
    `COALESCE(metadata->>'digest_delivered', 'false') <> 'true'`,
    `(
      COALESCE(metadata->>'digest_claim_id', '') = ''
      OR (
        COALESCE(metadata->>'digest_claimed_at', '') <> ''
        AND (metadata->>'digest_claimed_at')::timestamptz < NOW() - ($2::int * INTERVAL '1 minute')
      )
    )`,
  ];
  params.push(claimLeaseMinutes);
  if (team) {
    params.push(normalizedTeam);
    conditions.push(`team = $${params.length}`);
  }
  params.push(rowLimit);

  let rows: DigestRow[] = [];
  if (dryRun) {
    rows = await alarmDb.query('agent', `
      SELECT
        id,
        team,
        bot_name,
        severity,
        message,
        metadata,
        created_at
      FROM agent.event_lake
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at ASC
      LIMIT $${params.length}
    `, params) as DigestRow[];
  } else {
    params.push(claimId);
    params.push(nowIso);
    rows = await alarmDb.query('agent', `
      WITH candidates AS (
        SELECT id
        FROM agent.event_lake
        WHERE ${conditions.join(' AND ')}
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $${params.length - 2}
      ),
      claimed AS (
        UPDATE agent.event_lake target
        SET
          metadata = target.metadata || jsonb_build_object(
            'digest_claim_id', $${params.length - 1}::text,
            'digest_claimed_at', $${params.length}::text
          ),
          updated_at = NOW()
        FROM candidates
        WHERE target.id = candidates.id
        RETURNING
          target.id,
          target.team,
          target.bot_name,
          target.severity,
          target.message,
          target.metadata,
          target.created_at
      )
      SELECT *
      FROM claimed
      ORDER BY created_at ASC
    `, params) as DigestRow[];
  }

  const grouped = new Map<string, DigestRow[]>();
  for (const row of rows) {
    const key = normalizeTeam(row.team);
    const current = grouped.get(key) || [];
    current.push(row);
    grouped.set(key, current);
  }

  const batchId = `digest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const teamResults: Array<Record<string, unknown>> = [];

  for (const [teamKey, teamRows] of grouped.entries()) {
    const message = summarizeDigestMessage(teamKey, teamRows, nowIso);
    if (dryRun) {
      teamResults.push({
        team: teamKey,
        count: teamRows.length,
        sent: false,
        dry_run: true,
        preview: message,
      });
      continue;
    }

    let sent = false;
    let deliveryError = '';
    try {
      sent = await telegramSender.sendFromHubAlarm(teamKey, message);
      if (!sent) deliveryError = 'telegram_digest_send_failed';
    } catch (error: any) {
      sent = false;
      deliveryError = error?.message || 'telegram_digest_send_failed';
    }

    if (sent) {
      const ids = teamRows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id));
      if (ids.length > 0) {
        await alarmDb.run('agent', `
          UPDATE agent.event_lake
          SET
            metadata = (metadata - 'digest_claim_id' - 'digest_claimed_at') || jsonb_build_object(
              'digest_delivered', true,
              'digest_delivered_at', $2::text,
              'digest_batch_id', $3::text
            ),
            updated_at = NOW()
          WHERE id = ANY($1::bigint[])
            AND COALESCE(metadata->>'digest_claim_id', '') = $4::text
        `, [ids, nowIso, batchId, claimId]);
      }
    } else {
      const ids = teamRows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id));
      if (ids.length > 0) {
        await alarmDb.run('agent', `
          UPDATE agent.event_lake
          SET
            metadata = (metadata - 'digest_claim_id' - 'digest_claimed_at') || jsonb_build_object(
              'digest_last_delivery_error', $2::text,
              'digest_last_failed_at', $3::text
            ),
            updated_at = NOW()
          WHERE id = ANY($1::bigint[])
            AND COALESCE(metadata->>'digest_claim_id', '') = $4::text
        `, [ids, deliveryError || 'telegram_digest_send_failed', nowIso, claimId]);
      }
    }

    teamResults.push({
      team: teamKey,
      count: teamRows.length,
      sent,
      delivery_error: deliveryError || null,
      batch_id: sent ? batchId : null,
    });
  }

  return {
    ok: true,
    window_minutes: windowMinutes,
    limit: rowLimit,
    selected_count: rows.length,
    teams: teamResults,
    dry_run: dryRun,
  };
}

async function findRecentIncidentDuplicate({
  incidentKey,
  minutes,
}: {
  incidentKey: string;
  minutes: number;
}) {
  try {
    return await alarmDb.get('agent', `
      SELECT id, created_at, metadata
      FROM agent.event_lake
      WHERE event_type = 'hub_alarm'
        AND created_at >= NOW() - ($1::int * INTERVAL '1 minute')
        AND metadata->>'incident_key' = $2
      ORDER BY created_at DESC
      LIMIT 1
    `, [Math.max(1, Number(minutes || 0) || 1), incidentKey]);
  } catch {
    return null;
  }
}

async function findRecentClusterDuplicate({
  clusterKey,
  minutes,
}: {
  clusterKey: string;
  minutes: number;
}) {
  try {
    if (!clusterKey) return null;
    return await alarmDb.get('agent', `
      SELECT id, created_at, metadata
      FROM agent.event_lake
      WHERE event_type = 'hub_alarm'
        AND created_at >= NOW() - ($1::int * INTERVAL '1 minute')
        AND metadata->>'cluster_key' = $2
      ORDER BY created_at DESC
      LIMIT 1
    `, [Math.max(1, Number(minutes || 0) || 1), clusterKey]);
  } catch {
    return null;
  }
}

async function _insertLunaBlogRequest(regime: string, mood: string, keywordHints: string, eventId: number | null): Promise<void> {
  const urgency = regime === 'crisis' ? 9 : regime === 'volatile' ? 7 : 5;
  await alarmDb.run('blog', `
    INSERT INTO blog.content_requests
      (source_team, regime, mood, keyword_hints, urgency, status, expires_at, metadata)
    VALUES
      ('luna', $1, $2, $3, $4, 'pending', NOW() + INTERVAL '24 hours', $5::jsonb)
  `, [
    regime,
    mood,
    keywordHints || null,
    urgency,
    JSON.stringify({ event_id: eventId }),
  ]);
}

export async function alarmRoute(req: any, res: any) {
  try {
    if (alarmsDisabled()) {
      return res.json({
        ok: true,
        suppressed: true,
        reason: 'alerts_disabled',
        delivered: false,
        delivery_error: null,
      });
    }

    const message = normalizeText(req.body?.message);
    if (!message) {
      return res.status(400).json({ ok: false, error: 'message required' });
    }

    const team = normalizeTeam(req.body?.team);
    const fromBot = normalizeText(req.body?.fromBot, 'hub-alarm');
    const severity = normalizeSeverity(req.body?.severity);
    const title = normalizeText(req.body?.title, `${team} alarm`);
    const payload = req.body?.payload ?? {};
    const eventType = normalizeEventType(payload);

    const { type: baseAlarmType, confidence: classificationConfidence } = classifyAlarmTypeWithConfidence({
      requestedType: req.body?.alarmType ?? req.body?.alarm_type ?? req.body?.type,
      severity,
      eventType,
      title,
      message,
      payload,
    });

    let alarmType: AlarmType = baseAlarmType;
    let classificationSource = 'rule';
    let finalClassificationConfidence = classificationConfidence;
    let llmClassificationConfidence: number | null = null;

    if (classificationConfidence < 0.7) {
      const llmResult = await alarmRouteHooks.classifyAlarmWithLLM({ team, severity, title, message, eventType }).catch(() => null);
      if (llmResult && llmResult.confidence > classificationConfidence) {
        alarmType = llmResult.type as AlarmType;
        classificationSource = 'llm';
        finalClassificationConfidence = llmResult.confidence;
        llmClassificationConfidence = llmResult.confidence;
      }
    }

    const explicitHumanEscalation = isExplicitHumanEscalation({
      requestedVisibility: req.body?.visibility,
      requestedActionability: req.body?.actionability,
      payload,
    });

    if (explicitHumanEscalation && alarmType !== 'critical') {
      alarmType = 'critical';
    }
    const cooldownMinutes = Math.max(
      1,
      Number(req.body?.dedupeMinutes ?? req.body?.cooldownMinutes ?? 5) || 5,
    );
    let visibility = normalizeVisibility(req.body?.visibility)
      || defaultVisibility({
        severity,
        actionability: normalizeActionability(req.body?.actionability),
        alarmType,
        explicitHumanEscalation,
      });
    let actionability = normalizeActionability(req.body?.actionability)
      || defaultActionability({ severity, visibility, alarmType, explicitHumanEscalation });
    let status = normalizeStatus(req.body?.status)
      || defaultStatus({ actionability, visibility });
    const dispatchMode = getDispatchMode();
    const incidentKey = normalizeText(req.body?.incidentKey)
      || normalizeText(req.body?.incident_key)
      || buildIncidentKey({
        team,
        fromBot,
        eventType,
        title,
        message,
      });
    const clusterKey = alarmType === 'error'
      ? buildAlarmClusterKey({ team, fromBot, eventType, title, message, payload })
      : '';
    const suppressionRule = !explicitHumanEscalation
      ? findMatchingAlarmSuppressionRule({
          team,
          fromBot,
          alarmType,
          clusterKey,
          incidentKey,
        })
      : null;
    if (
      suppressionRule
      && suppressionRule.action === 'route_to_digest'
      && !['human_action', 'emergency'].includes(visibility)
    ) {
      visibility = 'digest';
      status = defaultStatus({ actionability, visibility });
    }
    const immediateHumanDelivery = shouldSendTelegramImmediately(visibility);
    const autoRepairShadowSkipped = dispatchMode === 'shadow'
      && alarmType === 'error'
      && actionability === 'auto_repair';

    const duplicate = await alarmEventLake.findRecentDuplicateAlarm({
      team,
      botName: fromBot,
      message,
      minutes: cooldownMinutes,
    });

    const duplicateByIncident = await findRecentIncidentDuplicate({
      incidentKey,
      minutes: cooldownMinutes,
    });
    const duplicateByCluster = alarmType === 'error'
      ? await findRecentClusterDuplicate({
          clusterKey,
          minutes: cooldownMinutes,
        })
      : null;

    if (duplicate || duplicateByIncident || duplicateByCluster) {
      return res.json({
        ok: true,
        deduped: true,
        event_id: duplicate?.id || duplicateByIncident?.id || duplicateByCluster?.id || null,
        incident_key: incidentKey,
        cluster_key: clusterKey || null,
        alarm_type: alarmType,
        visibility,
        actionability,
        status,
        governed: true,
        delivered: false,
        delivery_error: null,
      });
    }

    const eventId = await alarmEventLake.record({
      eventType: 'hub_alarm',
      team,
      botName: fromBot,
      severity,
      title,
      message,
      tags: [
        'hub',
        'alarm',
        `team:${team}`,
        `alarm_type:${alarmType}`,
        `visibility:${visibility}`,
        `actionability:${actionability}`,
      ],
      metadata: {
        source: 'hub_alarm_route',
        fromBot,
        event_type: eventType,
        incident_key: incidentKey,
        cluster_key: clusterKey || null,
        alarm_type: alarmType,
        visibility,
        actionability,
        status,
        suppression_rule_id: suppressionRule?.id || null,
        explicit_human_escalation: explicitHumanEscalation,
        immediate_human_delivery: immediateHumanDelivery,
        governed: true,
        classification_source: classificationSource,
        classification_confidence: finalClassificationConfidence,
        classification_rule_confidence: classificationConfidence,
        classification_llm_confidence: llmClassificationConfidence,
        dispatch_mode: dispatchMode,
        auto_repair_shadow_skipped: autoRepairShadowSkipped,
      },
    });

    const classificationRecord = await recordHubAlarmClassification({
      eventId,
      classifierSource: classificationSource,
      alarmType,
      finalConfidence: finalClassificationConfidence,
      ruleConfidence: classificationConfidence,
      llmConfidence: llmClassificationConfidence,
      incidentKey,
      dispatchMode,
    });
    const mirrorRecord = await recordHubAlarmMirror({
      team,
      fromBot,
      severity,
      alarmType,
      title,
      message,
      fingerprint: clusterKey || incidentKey,
      visibility,
      actionability,
      status,
      metadata: {
        source: 'hub_alarm_route',
        event_id: eventId,
        event_type: eventType,
        incident_key: incidentKey,
        cluster_key: clusterKey || null,
        dispatch_mode: dispatchMode,
        classification_source: classificationSource,
        classification_confidence: finalClassificationConfidence,
        auto_repair_shadow_skipped: autoRepairShadowSkipped,
      },
    });

    let delivered = false;
    let deliveryError = '';
    let autoRepair: Record<string, unknown> | null = null;
    let shadowObservation: Record<string, unknown> | null = null;
    let deliveryTeam = resolveAlarmDeliveryTeam({ alarmType, visibility, team });

    const isAutoDevMetaEvent = /^auto_dev_stage_/.test(eventType);
    if (alarmType === 'error' && actionability === 'auto_repair' && !isAutoDevMetaEvent) {
      if (autoRepairShadowSkipped) {
        autoRepair = {
          ok: true,
          skipped: true,
          reason: 'shadow_mode',
          auto_repair_shadow_skipped: true,
        };
      } else {
        try {
          autoRepair = await alarmRouteHooks.ensureAlarmAutoDevDocument({
            team,
            fromBot,
            severity,
            title,
            message,
            eventType,
            incidentKey,
            eventId,
            payload,
          });
          await alarmEventLake.record({
            eventType: 'hub_alarm_auto_repair_enqueued',
            team,
            botName: 'hub-alarm-governor',
            severity: severity === 'critical' ? 'warn' : 'info',
            title: 'Alarm auto repair document queued',
            message: `auto_dev repair document queued for ${incidentKey}`,
            tags: ['hub', 'alarm', 'auto_repair', `team:${team}`],
            metadata: {
              source: 'hub_alarm_route',
              incident_key: incidentKey,
              cluster_key: clusterKey || null,
              alarm_event_id: eventId,
              auto_dev_path: autoRepair.path || null,
              created: autoRepair.created === true,
            },
          });
        } catch (error: any) {
          autoRepair = {
            ok: false,
            error: error?.message || 'auto_repair_document_failed',
          };
        }
      }
    }

    // Roundtable: fire-and-forget for critical/repeat errors (does not block response)
    // Shadow mode: skip roundtable to prevent auto-dev doc generation during validation
    const roundtableTriggered = dispatchMode !== 'shadow' && await alarmRouteHooks.shouldTriggerRoundtable({
      alarmType,
      visibility,
      clusterKey: clusterKey || undefined,
      incidentKey,
      fromBot,
      title,
      message,
      payload,
    }).catch(() => false);
    if (roundtableTriggered) {
      alarmRouteHooks.runRoundtable({
        alarmId: eventId,
        incidentKey,
        team,
        fromBot,
        severity,
        title,
        message,
        alarmType,
        clusterKey: clusterKey || undefined,
        autoDevDocPath: autoRepair && typeof autoRepair.path === 'string' ? autoRepair.path : undefined,
        payload,
      }).catch(() => null);
    }

    if (immediateHumanDelivery) {
      try {
        const [interpretation, enrichment] = await Promise.allSettled([
          alarmRouteHooks.interpretAlarm({ alarmType, team, severity, title, message }),
          alarmRouteHooks.enrichAlarm({ team, clusterKey: clusterKey || undefined }),
        ]);

        const interpreted = interpretation.status === 'fulfilled' ? interpretation.value : null;
        const enriched = enrichment.status === 'fulfilled' ? enrichment.value : null;
        if (dispatchMode === 'shadow') {
          shadowObservation = {
            interpretation_attempted: true,
            interpreted: Boolean(interpreted?.summary),
            enrichment_attempted: true,
            enriched: Boolean(enriched),
            cluster_count: enriched?.clusterCount ?? null,
          };
        }

        let deliveryMessage: string;
        if (interpreted?.summary) {
          const parts = [interpreted.summary];
          if (interpreted.actionRecommendation) parts.push(`💡 ${interpreted.actionRecommendation}`);
          if (interpreted.impactScope) parts.push(`📍 영향: ${interpreted.impactScope}`);
          if (interpreted.rootCauseCandidates?.length) {
            parts.push(`🔍 원인 후보: ${interpreted.rootCauseCandidates.slice(0, 3).join(' / ')}`);
          }
          if (enriched?.clusterCount && enriched.clusterCount > 1) {
            parts.push(`🔁 반복: ${enriched.clusterCount}회`);
          }
          parts.push(`📎 ${incidentKey}`);
          deliveryMessage = parts.join('\n');
        } else {
          deliveryMessage = formatAlarmNotification({
            alarmType,
            team,
            severity,
            title,
            message,
            eventType,
            incidentKey,
          });
          if (enriched?.clusterCount && enriched.clusterCount > 1) {
            deliveryMessage += `\n🔁 반복: ${enriched.clusterCount}회`;
          }
        }

        if (dispatchMode !== 'shadow') {
          delivered = severity === 'critical' || visibility === 'emergency'
            ? await telegramSender.sendCriticalFromHubAlarm(deliveryTeam, deliveryMessage)
            : await telegramSender.sendFromHubAlarm(deliveryTeam, deliveryMessage);
          if (!delivered) deliveryError = telegramSender.getLastTelegramSendError?.() || 'telegram_send_failed';
        }
      } catch (error: any) {
        deliveryError = error?.message || 'telegram_send_failed';
      }
    }

    if (fromBot.includes('cross_team_router') && team === 'blog') {
      const lunaReq = _parseLunaBlogRequest(message);
      if (lunaReq) {
        _insertLunaBlogRequest(lunaReq.regime, lunaReq.mood, lunaReq.keywordHints, eventId).catch((err: any) => {
          console.warn('[허브/알람] luna→blog content_request 삽입 실패 (무시):', err?.message);
        });
      }
    }

    return res.json({
      ok: true,
      event_id: eventId,
      incident_key: incidentKey,
      cluster_key: clusterKey || null,
      event_type: eventType,
      alarm_type: alarmType,
      classification_source: classificationSource,
      classification_confidence: finalClassificationConfidence,
      classification_rule_confidence: classificationConfidence,
      classification_llm_confidence: llmClassificationConfidence,
      visibility,
      actionability,
      status,
      suppression_rule_id: suppressionRule?.id || null,
      governed: true,
      dispatch_mode: dispatchMode,
      immediate_delivery: immediateHumanDelivery,
      delivery_team: immediateHumanDelivery && dispatchMode !== 'shadow' ? deliveryTeam : null,
      delivered,
      delivery_error: deliveryError || null,
      auto_repair: autoRepair,
      auto_repair_shadow_skipped: autoRepairShadowSkipped,
      shadow_observation: shadowObservation,
      mirror_records: {
        classification: classificationRecord,
        alarm: mirrorRecord,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

function normalizeAutoRepairStatus(value: unknown): 'resolved' | 'partially_resolved' | 'unresolved_needs_human' {
  const normalized = normalizeText(value, 'resolved').toLowerCase();
  if (['resolved', 'fixed', 'done', 'completed'].includes(normalized)) return 'resolved';
  if (['partial', 'partially_resolved', 'partially-resolved'].includes(normalized)) return 'partially_resolved';
  return 'unresolved_needs_human';
}

export async function alarmAutoRepairCallbackRoute(req: any, res: any) {
  try {
    const incidentKey = normalizeText(req.body?.incidentKey || req.body?.incident_key);
    if (!incidentKey) return res.status(400).json({ ok: false, error: 'incident_key_required' });
    const team = normalizeTeam(req.body?.team);
    const status = normalizeAutoRepairStatus(req.body?.status);
    const summary = normalizeText(req.body?.summary, '오류 처리 결과가 등록되었습니다.');
    const docPath = normalizeText(req.body?.docPath || req.body?.doc_path);
    const changedFiles = Array.isArray(req.body?.changedFiles || req.body?.changed_files)
      ? (req.body?.changedFiles || req.body?.changed_files).map((item: unknown) => normalizeText(item)).filter(Boolean).slice(0, 12)
      : [];
    const severity = status === 'unresolved_needs_human' ? 'warn' : 'info';
    const visibility = status === 'unresolved_needs_human' ? 'human_action' : 'notify';
    const deliveryTeam = resolveAlarmDeliveryTeam({
      alarmType: 'error',
      visibility: status === 'unresolved_needs_human' ? 'human_action' : 'notify',
      team,
    });
    const message = formatAutoRepairResultMessage({
      team,
      status,
      incidentKey,
      summary,
      docPath,
      changedFiles,
    });
    const eventId = await eventLake.record({
      eventType: 'hub_alarm_auto_repair_result',
      team,
      botName: normalizeText(req.body?.fromBot, 'auto-dev'),
      severity,
      title: 'Alarm auto repair result',
      message,
      tags: ['hub', 'alarm', 'auto_repair_result', `team:${team}`, `status:${status}`],
      metadata: {
        source: 'hub_alarm_auto_repair_callback',
        incident_key: incidentKey,
        status,
        doc_path: docPath || null,
        changed_files: changedFiles,
        visibility,
      },
    });

    let delivered = false;
    let deliveryError = '';
    try {
      delivered = await telegramSender.sendFromHubAlarm(deliveryTeam, message);
      if (!delivered) deliveryError = telegramSender.getLastTelegramSendError?.() || 'telegram_send_failed';
    } catch (error: any) {
      deliveryError = error?.message || 'telegram_send_failed';
    }

    return res.json({
      ok: true,
      event_id: eventId,
      incident_key: incidentKey,
      status,
      visibility,
      delivery_team: deliveryTeam,
      delivered,
      delivery_error: deliveryError || null,
    });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || 'auto_repair_callback_failed' });
  }
}

export async function alarmNoisyProducersRoute(req: any, res: any) {
  try {
    const minutes = Math.max(1, Number(req.query?.minutes ?? 60) || 60);
    const limit = Math.min(50, Math.max(1, Number(req.query?.limit ?? 10) || 10));
    const rows = await alarmDb.query('agent', `
      SELECT
        COALESCE(metadata->>'fromBot', bot_name, 'unknown') AS producer,
        team,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE metadata->>'visibility' IN ('human_action', 'emergency'))::int AS escalated,
        MAX(created_at) AS latest_at
      FROM agent.event_lake
      WHERE event_type = 'hub_alarm'
        AND created_at >= NOW() - ($1::int * INTERVAL '1 minute')
      GROUP BY producer, team
      ORDER BY total DESC, latest_at DESC
      LIMIT $2
    `, [minutes, limit]);

    return res.json({
      ok: true,
      minutes,
      limit,
      producers: rows,
    });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || 'noisy_producer_query_failed' });
  }
}

export async function alarmSuppressDryRunRoute(req: any, res: any) {
  try {
    const minutes = Math.max(1, Number(req.body?.minutes ?? 60) || 60);
    const fromBot = normalizeText(req.body?.fromBot || req.body?.from_bot);
    const team = normalizeText(req.body?.team).toLowerCase();
    const visibility = normalizeVisibility(req.body?.visibility);
    const eventType = normalizeText(req.body?.eventType || req.body?.event_type).toLowerCase();
    const incidentKeyPrefix = normalizeText(req.body?.incidentKeyPrefix || req.body?.incident_key_prefix);

    const params: unknown[] = [minutes];
    const conditions = [`event_type = 'hub_alarm'`, `created_at >= NOW() - ($1::int * INTERVAL '1 minute')`];
    let index = 2;

    if (fromBot) {
      params.push(fromBot);
      conditions.push(`COALESCE(metadata->>'fromBot', bot_name) = $${index++}`);
    }
    if (team) {
      params.push(team);
      conditions.push(`team = $${index++}`);
    }
    if (visibility) {
      params.push(visibility);
      conditions.push(`metadata->>'visibility' = $${index++}`);
    }
    if (eventType) {
      params.push(eventType);
      conditions.push(`COALESCE(metadata->>'event_type', '') = $${index++}`);
    }
    if (incidentKeyPrefix) {
      params.push(`${incidentKeyPrefix}%`);
      conditions.push(`COALESCE(metadata->>'incident_key', '') ILIKE $${index++}`);
    }

    const rows = await alarmDb.query('agent', `
      SELECT
        id,
        team,
        bot_name,
        severity,
        message,
        metadata,
        created_at
      FROM agent.event_lake
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT 20
    `, params);

    const countRow = await alarmDb.get('agent', `
      SELECT COUNT(*)::int AS total
      FROM agent.event_lake
      WHERE ${conditions.join(' AND ')}
    `, params);

    return res.json({
      ok: true,
      minutes,
      matched_total: Number(countRow?.total || 0),
      sample: rows,
      rule: {
        fromBot: fromBot || null,
        team: team || null,
        visibility: visibility || null,
        eventType: eventType || null,
        incidentKeyPrefix: incidentKeyPrefix || null,
      },
      dry_run: true,
    });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || 'suppress_dry_run_failed' });
  }
}

export async function alarmDigestFlushRoute(req: any, res: any) {
  try {
    const payload = req.body || {};
    const result = await flushAlarmDigest({
      minutes: Number(payload.minutes ?? req.query?.minutes ?? 240),
      limit: Number(payload.limit ?? req.query?.limit ?? 200),
      team: normalizeText(payload.team ?? req.query?.team, ''),
      dryRun: String(payload.dry_run ?? payload.dryRun ?? req.query?.dry_run ?? '').trim() === '1'
        || payload.dryRun === true
        || payload.dry_run === true,
    });
    return res.json(result);
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || 'alarm_digest_flush_failed' });
  }
}

export async function alarmReadinessRoute(_req: any, res: any) {
  try {
    return res.json(buildAlarmReadinessSnapshot());
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || 'alarm_readiness_failed' });
  }
}

export async function alarmSuppressionProposalsRoute(req: any, res: any) {
  try {
    const result = await buildAlarmSuppressionProposals({
      minutes: Math.max(1, Number(req.query?.minutes ?? 24 * 60) || 24 * 60),
      limit: Math.min(100, Math.max(1, Number(req.query?.limit ?? 20) || 20)),
      minTotal: Math.max(2, Number(req.query?.min_total ?? req.query?.minTotal ?? 5) || 5),
      db: alarmDb,
    });
    return res.json(result);
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || 'alarm_suppression_proposals_failed' });
  }
}

export async function alarmSuppressionApplyRoute(req: any, res: any) {
  try {
    const payload = req.body || {};
    const result = await applyAlarmSuppressionProposals({
      minutes: Math.max(1, Number(payload.minutes ?? req.query?.minutes ?? 24 * 60) || 24 * 60),
      limit: Math.min(100, Math.max(1, Number(payload.limit ?? req.query?.limit ?? 20) || 20)),
      minTotal: Math.max(2, Number(payload.min_total ?? payload.minTotal ?? req.query?.min_total ?? req.query?.minTotal ?? 5) || 5),
      db: alarmDb,
    });
    return res.json(result);
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || 'alarm_suppression_apply_failed' });
  }
}
