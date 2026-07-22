// @ts-nocheck

function parseMeta(value = {}) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return {};
  }
}

function cleanPart(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

export function normalizeSourceRef(value = null) {
  const input = parseMeta(value);
  const team = cleanPart(input.team);
  const table = cleanPart(input.table || input.sourceTable);
  const id = cleanPart(input.id || input.sourceId);
  if (!team || !table || !id) return null;
  return { team, table, id };
}

export function sourceRefKey(value = null) {
  const ref = normalizeSourceRef(value);
  return ref ? `${ref.team}:${ref.table}:${ref.id}` : null;
}

export function sourceRefMatches(left = null, right = null) {
  const leftKey = sourceRefKey(left);
  return Boolean(leftKey && leftKey === sourceRefKey(right));
}

export function attachSourceRefToMeta(meta = {}, sourceRef = null) {
  const base = parseMeta(meta);
  const ref = normalizeSourceRef(sourceRef) || inferSourceRefFromMeta(base);
  return ref ? { ...base, source_ref: ref } : base;
}

export function extractSourceRef(input = {}) {
  const meta = parseMeta(input?.meta ?? input);
  return normalizeSourceRef(meta.source_ref) || inferSourceRefFromMeta(meta);
}

export function inferSourceRefFromMeta(meta = {}, fallback = {}) {
  const base = parseMeta(meta);
  const team = cleanPart(base.team || fallback.team);
  const table = cleanPart(base.sourceTable || fallback.table);
  const id = cleanPart(base.sourceId || fallback.id);
  return normalizeSourceRef({ team, table, id });
}

export function sourceRefFromCandidate(candidate = {}, fallbackTeam = null) {
  const meta = parseMeta(candidate.meta || {});
  return inferSourceRefFromMeta(meta, {
    team: fallbackTeam || meta.team || candidate.team,
    table: candidate.sourceTable,
    id: candidate.sourceId,
  });
}

export function sourceRefForLibraryRecord(record = {}) {
  const payload = parseMeta(record.payload || {});
  const sourceKind = String(record.sourceKind || '').trim();
  const sourceId = cleanPart(record.sourceId || payload.id || payload.tradeId || payload.trade_id);
  const team = cleanPart(record.team);
  const tableByKind = {
    agent_message: 'public.agent_messages',
    claude_auto_dev: 'claude.auto_dev_outcomes',
    claude_refactor: 'claude.auto_dev_outcomes',
    dpo_preference: 'public.dpo_preferences',
    hub_alarm: 'hub.alarms',
    luna_reflexion: 'investment.luna_reflexion',
    luna_learned_bias: 'investment.luna_regime_weight_snapshots',
    luna_jaenong_shadow: 'investment.jaenong_route_shadow',
    luna_signal: 'investment.signals',
    luna_trade_journal: 'investment.trade_journal',
    luna_trade_review: 'investment.trade_review',
    mcp_usage: 'public.sigma_mcp_usage_audit',
    sigma_directive: 'public.sigma_v2_directive_audit',
  };
  const idByKind = {
    luna_trade_journal: payload.tradeId || payload.trade_id || sourceId,
    luna_trade_review: payload.tradeId || payload.trade_id || sourceId,
    sigma_directive: payload.transport?.sourceRowId || sourceId,
  };
  return normalizeSourceRef({
    team,
    table: tableByKind[sourceKind] || `${team || 'unknown'}.${sourceKind || 'unknown'}`,
    id: idByKind[sourceKind] || sourceId,
  });
}

export default {
  normalizeSourceRef,
  sourceRefKey,
  sourceRefMatches,
  attachSourceRefToMeta,
  extractSourceRef,
  inferSourceRefFromMeta,
  sourceRefFromCandidate,
  sourceRefForLibraryRecord,
};
