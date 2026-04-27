const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

type AlarmSuppressionRule = {
  id: string;
  enabled: boolean;
  team: string;
  fromBot: string;
  alarmType: string;
  action: 'route_to_digest' | 'reduce_repeat_interval' | 'tighten_incident_key' | string;
  clusterKey: string | null;
  incidentKeyPrefix: string | null;
  createdAt: string;
  updatedAt: string;
  source: string;
};

type RuleMatchInput = {
  team: string;
  fromBot: string;
  alarmType: string;
  clusterKey?: string | null;
  incidentKey?: string | null;
};

function runtimeRoot(): string {
  return String(process.env.HUB_RUNTIME_DIR || process.env.JAY_RUNTIME_DIR || '').trim()
    || path.join(os.homedir(), '.ai-agent-system', 'hub');
}

export function alarmSuppressionRulesPath(): string {
  return String(process.env.HUB_ALARM_SUPPRESSION_RULES_PATH || '').trim()
    || path.join(runtimeRoot(), 'alarm', 'suppression-rules.json');
}

function normalizeText(value: unknown, fallback = ''): string {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function stableRuleId(rule: Partial<AlarmSuppressionRule>): string {
  const material = [
    normalizeText(rule.team, 'unknown').toLowerCase(),
    normalizeText(rule.fromBot, 'unknown'),
    normalizeText(rule.alarmType, 'unknown').toLowerCase(),
    normalizeText(rule.action, 'route_to_digest'),
    normalizeText(rule.clusterKey, ''),
    normalizeText(rule.incidentKeyPrefix, ''),
  ].join('|');
  return `rule_${crypto.createHash('sha1').update(material).digest('hex').slice(0, 16)}`;
}

function normalizeRule(raw: Record<string, any>, nowIso = new Date().toISOString()): AlarmSuppressionRule | null {
  const team = normalizeText(raw.team).toLowerCase();
  const fromBot = normalizeText(raw.fromBot || raw.from_bot || raw.producer);
  const alarmType = normalizeText(raw.alarmType || raw.alarm_type || 'unknown').toLowerCase();
  const action = normalizeText(raw.action || 'route_to_digest');
  if (!team || !fromBot || !action) return null;
  const rule: AlarmSuppressionRule = {
    id: normalizeText(raw.id) || stableRuleId({ team, fromBot, alarmType, action, clusterKey: raw.clusterKey, incidentKeyPrefix: raw.incidentKeyPrefix }),
    enabled: raw.enabled !== false,
    team,
    fromBot,
    alarmType,
    action,
    clusterKey: normalizeText(raw.clusterKey || raw.cluster_key) || null,
    incidentKeyPrefix: normalizeText(raw.incidentKeyPrefix || raw.incident_key_prefix) || null,
    createdAt: normalizeText(raw.createdAt || raw.created_at, nowIso),
    updatedAt: normalizeText(raw.updatedAt || raw.updated_at, nowIso),
    source: normalizeText(raw.source, 'alarm_suppression_proposals'),
  };
  return rule;
}

export function loadAlarmSuppressionRules(rulesPath = alarmSuppressionRulesPath()): AlarmSuppressionRule[] {
  try {
    if (!fs.existsSync(rulesPath)) return [];
    const parsed = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    const rows = Array.isArray(parsed?.rules) ? parsed.rules : Array.isArray(parsed) ? parsed : [];
    return rows
      .map((row: Record<string, any>) => normalizeRule(row))
      .filter(Boolean) as AlarmSuppressionRule[];
  } catch (error: any) {
    console.warn(`[alarm-suppression-rules] 룰 로드 실패: ${error?.message || error}`);
    return [];
  }
}

export function saveAlarmSuppressionRules(rules: AlarmSuppressionRule[], rulesPath = alarmSuppressionRulesPath()): void {
  fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
  fs.writeFileSync(rulesPath, `${JSON.stringify({
    updated_at: new Date().toISOString(),
    rules,
  }, null, 2)}\n`, 'utf8');
}

export function upsertAlarmSuppressionRules(
  proposals: Array<Record<string, any>>,
  {
    rulesPath = alarmSuppressionRulesPath(),
    nowIso = new Date().toISOString(),
  }: { rulesPath?: string; nowIso?: string } = {},
) {
  const existing = loadAlarmSuppressionRules(rulesPath);
  const byId = new Map(existing.map((rule) => [rule.id, rule]));
  const applied: AlarmSuppressionRule[] = [];
  const skipped: Array<Record<string, unknown>> = [];

  for (const proposal of proposals || []) {
    const action = normalizeText(proposal.action);
    if (!['route_to_digest', 'reduce_repeat_interval'].includes(action)) {
      skipped.push({
        action,
        reason: 'manual_review_required',
        team: proposal.team,
        producer: proposal.producer,
      });
      continue;
    }
    const rawRule = {
      team: proposal.team,
      fromBot: proposal.producer || proposal.fromBot,
      alarmType: proposal.alarm_type || proposal.alarmType,
      action,
      clusterKey: proposal.cluster_key || proposal.dry_run_rule?.clusterKey || null,
      incidentKeyPrefix: proposal.dry_run_rule?.incidentKeyPrefix || null,
      enabled: true,
      source: 'alarm_suppression_proposals_apply',
      updatedAt: nowIso,
      createdAt: nowIso,
    };
    const normalized = normalizeRule(rawRule, nowIso);
    if (!normalized) {
      skipped.push({ reason: 'invalid_rule', proposal });
      continue;
    }
    const previous = byId.get(normalized.id);
    const merged = previous
      ? { ...previous, ...normalized, createdAt: previous.createdAt, updatedAt: nowIso }
      : normalized;
    byId.set(merged.id, merged);
    applied.push(merged);
  }

  if (applied.length > 0) {
    saveAlarmSuppressionRules([...byId.values()], rulesPath);
  }

  return {
    ok: true,
    rules_path: rulesPath,
    applied_count: applied.length,
    skipped_count: skipped.length,
    applied,
    skipped,
  };
}

export function findMatchingAlarmSuppressionRule(input: RuleMatchInput): AlarmSuppressionRule | null {
  const team = normalizeText(input.team).toLowerCase();
  const fromBot = normalizeText(input.fromBot);
  const alarmType = normalizeText(input.alarmType).toLowerCase();
  const clusterKey = normalizeText(input.clusterKey || '');
  const incidentKey = normalizeText(input.incidentKey || '');

  for (const rule of loadAlarmSuppressionRules()) {
    if (!rule.enabled) continue;
    if (rule.team !== team) continue;
    if (rule.fromBot !== fromBot) continue;
    if (rule.alarmType && rule.alarmType !== 'unknown' && rule.alarmType !== alarmType) continue;
    if (rule.clusterKey && rule.clusterKey !== clusterKey) continue;
    if (rule.incidentKeyPrefix && !incidentKey.startsWith(rule.incidentKeyPrefix)) continue;
    return rule;
  }
  return null;
}

module.exports = {
  alarmSuppressionRulesPath,
  findMatchingAlarmSuppressionRule,
  loadAlarmSuppressionRules,
  saveAlarmSuppressionRules,
  upsertAlarmSuppressionRules,
};
