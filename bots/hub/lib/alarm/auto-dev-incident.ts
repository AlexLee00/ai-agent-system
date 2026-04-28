'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const env = require('../../../../packages/core/lib/env');

const DEFAULT_AUTO_DEV_DIR = path.join(env.PROJECT_ROOT, 'docs', 'auto_dev');

function normalizeText(value: unknown, fallback = ''): string {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function slugify(value: string): string {
  return normalizeText(value, 'incident')
    .toLowerCase()
    .replace(/[^a-z0-9가-힣._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'incident';
}

function redactText(value: unknown): string {
  return normalizeText(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password)\s*[:=]\s*['"]?[^,'"\s}]+/gi, '$1=[REDACTED]')
    .replace(/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9._-]{16,}/g, '[REDACTED_TOKEN]')
    .replace(/[A-Za-z0-9+/=]{48,}/g, '[REDACTED_BLOB]');
}

function safeJson(value: unknown, maxChars = 2400): string {
  try {
    const seen = new WeakSet();
    const text = JSON.stringify(value || {}, (key, raw) => {
      if (/api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password/i.test(String(key || ''))) {
        return '[REDACTED]';
      }
      if (raw && typeof raw === 'object') {
        if (seen.has(raw)) return '[Circular]';
        seen.add(raw);
      }
      if (typeof raw === 'string') return redactText(raw).slice(0, 800);
      return raw;
    }, 2);
    return redactText(text).slice(0, maxChars);
  } catch {
    return '{}';
  }
}

function resolveWriteScope(payload: unknown): string[] {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const raw = (payload as Record<string, unknown>).write_scope || (payload as Record<string, unknown>).writeScope;
    if (Array.isArray(raw)) {
      const scopes = raw.map((item) => normalizeText(item)).filter(Boolean).slice(0, 8);
      if (scopes.length > 0) return scopes;
    }
  }
  return ['bots', 'packages', 'scripts'];
}

function yamlList(items: string[]): string {
  return items.map((item) => `  - ${item}`).join('\n');
}

export function buildAlarmAutoDevDocument({
  team,
  fromBot,
  severity,
  title,
  message,
  eventType,
  incidentKey,
  eventId,
  payload,
}: {
  team: string;
  fromBot: string;
  severity: string;
  title: string;
  message: string;
  eventType: string;
  incidentKey: string;
  eventId: number | string | null;
  payload?: unknown;
}): string {
  const writeScope = resolveWriteScope(payload);
  const riskTier = severity === 'critical' ? 'high' : 'medium';
  const safeMessage = redactText(message).slice(0, 2400);
  const safePayload = safeJson(payload);
  const createdAt = new Date().toISOString();
  return [
    '---',
    'target_team: claude',
    'owner_agent: hub-alarm-governor',
    `source_team: ${normalizeText(team, 'unknown')}`,
    `source_bot: ${normalizeText(fromBot, 'unknown')}`,
    `incident_key: ${normalizeText(incidentKey, 'unknown')}`,
    `alarm_event_type: ${normalizeText(eventType, 'unknown')}`,
    `risk_tier: ${riskTier}`,
    'task_type: development_task',
    'write_scope:',
    yamlList(writeScope),
    'test_scope:',
    '  - npm --prefix bots/hub run -s test:unit',
    '  - npm --prefix bots/hub run -s transition:completion-gate',
    'autonomy_level: autonomous_l5',
    'requires_live_execution: false',
    '---',
    '',
    `# Alarm Incident Auto-Repair: ${normalizeText(title, 'Hub alarm incident')}`,
    '',
    '## Council',
    '- Jay: 운영 영향과 알람 정책을 검토한다.',
    '- Claude lead: 구현계획을 수립하고 auto_dev 상태머신으로 수정한다.',
    '- Error team lead: 재현, 원인, 회귀 테스트 기준을 제시한다.',
    '',
    '## Incident',
    `- created_at: ${createdAt}`,
    `- event_id: ${eventId || 'pending'}`,
    `- incident_key: ${incidentKey}`,
    `- team: ${team}`,
    `- from_bot: ${fromBot}`,
    `- severity: ${severity}`,
    `- event_type: ${eventType}`,
    '',
    '## Error Message',
    '```text',
    safeMessage || '(empty)',
    '```',
    '',
    '## Payload Summary',
    '```json',
    safePayload,
    '```',
    '',
    '## Required Flow',
    '1. 재현 가능한 최소 원인을 찾는다.',
    '2. 동일/유사 알람이 반복되는지 event_lake와 코드 경로를 확인한다.',
    '3. 중복 알람, 잘못된 severity, 잘못된 topic routing이 있으면 함께 수정한다.',
    '4. 관련 smoke 또는 unit test를 추가한다.',
    '5. 수정 후 오류 해소/미해결 결과만 텔레그램으로 보고한다.',
    '',
    '## Acceptance Criteria',
    '- 같은 incident_key가 반복되어도 사용자에게 직접 알람 폭주가 발생하지 않는다.',
    '- 복구 가능 오류는 auto_dev 수정 문서와 테스트로 이어진다.',
    '- 능력 밖인 경우 미해결 원인과 사람이 확인할 액션만 보고한다.',
    '',
  ].join('\n');
}

export function buildAlarmAutoDevDocumentWithConsensus(
  input: {
    team: string;
    fromBot: string;
    severity: string;
    title: string;
    message: string;
    eventType: string;
    incidentKey: string;
    eventId: number | string | null;
    payload?: unknown;
  },
  consensus: {
    rootCause?: string;
    proposedFix?: string;
    estimatedComplexity?: string;
    riskLevel?: string;
    successCriteria?: string;
    roundtableId?: number | null;
  } | null = null,
): string {
  const base = buildAlarmAutoDevDocument(input);
  if (!consensus) return base;
  const consensusSection = [
    '',
    '## Roundtable Consensus',
    `- roundtable_id: ${consensus.roundtableId || 'unknown'}`,
    `- root_cause: ${normalizeText(consensus.rootCause, '미결정')}`,
    `- proposed_fix: ${normalizeText(consensus.proposedFix, '검토 필요')}`,
    `- estimated_complexity: ${normalizeText(consensus.estimatedComplexity, 'medium')}`,
    `- risk_level: ${normalizeText(consensus.riskLevel, 'medium')}`,
    `- success_criteria: ${normalizeText(consensus.successCriteria, '오류 재발 없음')}`,
    '',
  ].join('\n');
  return base + consensusSection;
}

export async function ensureAlarmAutoDevDocument(input: {
  team: string;
  fromBot: string;
  severity: string;
  title: string;
  message: string;
  eventType: string;
  incidentKey: string;
  eventId: number | string | null;
  payload?: unknown;
  consensus?: {
    rootCause?: string;
    proposedFix?: string;
    estimatedComplexity?: string;
    riskLevel?: string;
    successCriteria?: string;
    roundtableId?: number | null;
  } | null;
}) {
  const dir = process.env.HUB_ALARM_AUTO_DEV_DIR || DEFAULT_AUTO_DEV_DIR;
  const keyHash = crypto.createHash('sha1').update(input.incidentKey || input.message || 'incident').digest('hex').slice(0, 12);
  const fileName = `ALARM_INCIDENT_${slugify(input.team)}_${keyHash}.md`;
  const filePath = path.join(dir, fileName);
  const relPath = path.relative(env.PROJECT_ROOT, filePath).replace(/\\/g, '/');

  await fs.promises.mkdir(dir, { recursive: true });
  if (fs.existsSync(filePath)) {
    return { ok: true, created: false, path: relPath };
  }
  const content = input.consensus
    ? buildAlarmAutoDevDocumentWithConsensus(input, input.consensus)
    : buildAlarmAutoDevDocument(input);
  await fs.promises.writeFile(filePath, content, 'utf8');
  return { ok: true, created: true, path: relPath };
}

module.exports = {
  buildAlarmAutoDevDocument,
  buildAlarmAutoDevDocumentWithConsensus,
  ensureAlarmAutoDevDocument,
};
