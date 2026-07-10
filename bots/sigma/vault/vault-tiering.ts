// @ts-nocheck

export const VAULT_TIERS = {
  RAW_CORPUS: 'raw_corpus',
  KNOWLEDGE: 'knowledge',
  UNKNOWN: 'unknown',
};

export const RAW_CORPUS_TYPES = new Set([
  'blog_comment',
  'blog_post',
  'blog_external_trend',
  'code_structure',
  'code_structure_snapshot',
  'git_commit',
  'git_history',
]);

export const KNOWLEDGE_TYPES = new Set([
  'auto_dev_outcome',
  'library_record',
  'llm_wiki',
  'popular_pattern',
  'refactor_outcome',
  'sigma_dreaming_digest',
]);

const RAW_CORPUS_SOURCE_TABLES = new Set([
  'blog.comment_actions',
  'blog.comments',
  'blog.posts',
  'blog.trend_topics',
  'git.commits',
  'git.history',
  'repo.code_structure',
]);

const SURPRISING_META_KEYS = [
  'insight',
  'lesson',
  'nonObvious',
  'pattern',
  'surprising',
  'surprisingSignal',
  'takeaway',
];

function parseMeta(value = {}) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return {};
  }
}

function clean(value) {
  return String(value ?? '').trim().toLowerCase();
}

function sourceKind(entry = {}, meta = parseMeta(entry.meta)) {
  return clean(meta.sourceKind || entry.sourceKind || entry.type || entry.source);
}

function sourceTable(entry = {}, meta = parseMeta(entry.meta)) {
  return clean(meta.sourceTable || meta.source_ref?.table || entry.sourceTable);
}

export function isRequeryableRawSource(entry = {}) {
  const meta = parseMeta(entry.meta);
  const type = clean(entry.type);
  const source = clean(entry.source);
  const kind = sourceKind(entry, meta);
  const table = sourceTable(entry, meta);

  if (RAW_CORPUS_TYPES.has(type) || RAW_CORPUS_TYPES.has(kind)) return true;
  if (RAW_CORPUS_SOURCE_TABLES.has(table)) return true;
  if (type.startsWith('git_') || kind.startsWith('git_') || source.startsWith('git_')) return true;
  if (type.startsWith('code_structure') || kind.startsWith('code_structure')) return true;
  return false;
}

export function resolveVaultTier(entry = {}) {
  const meta = parseMeta(entry.meta);
  const explicitTier = clean(meta.vaultTier || meta.vault_tier || entry.vaultTier || entry.vault_tier);
  if (explicitTier === VAULT_TIERS.RAW_CORPUS || explicitTier === VAULT_TIERS.KNOWLEDGE) {
    return { tier: explicitTier, reason: 'explicit_meta_tier' };
  }

  const type = clean(entry.type);
  const kind = sourceKind(entry, meta);
  if (RAW_CORPUS_TYPES.has(type) || RAW_CORPUS_TYPES.has(kind) || isRequeryableRawSource(entry)) {
    return { tier: VAULT_TIERS.RAW_CORPUS, reason: `raw_source:${type || kind || 'unknown'}` };
  }
  if (KNOWLEDGE_TYPES.has(type) || KNOWLEDGE_TYPES.has(kind)) {
    return { tier: VAULT_TIERS.KNOWLEDGE, reason: `knowledge_type:${type || kind || 'unknown'}` };
  }
  return { tier: VAULT_TIERS.UNKNOWN, reason: `unmapped_type:${type || kind || 'unknown'}` };
}

export function hasSurprisingKnowledgeSignal(entry = {}) {
  const meta = parseMeta(entry.meta);
  const type = clean(entry.type);
  if (type === 'popular_pattern' || type === 'llm_wiki' || type === 'sigma_dreaming_digest') return true;
  return SURPRISING_META_KEYS.some((key) => {
    const value = meta[key];
    if (typeof value === 'boolean') return value === true;
    if (Array.isArray(value)) return value.length > 0;
    return String(value ?? '').trim().length > 0;
  });
}

export function knowledgeHygieneCheck(entry = {}, options = {}) {
  const resolved = resolveVaultTier(entry);
  const targetTier = options.targetTier || resolved.tier;
  const reasons = [];
  const warnings = [];
  const requeryableRaw = isRequeryableRawSource(entry);

  if (targetTier !== VAULT_TIERS.KNOWLEDGE) {
    return { allowed: true, targetTier, resolvedTier: resolved.tier, reasons, warnings };
  }
  if (requeryableRaw) reasons.push('requeryable_raw_source');
  if (!hasSurprisingKnowledgeSignal(entry)) reasons.push('missing_surprising_signal');
  if (resolved.tier === VAULT_TIERS.UNKNOWN) reasons.push('unmapped_entry_type');

  return {
    allowed: reasons.length === 0,
    targetTier,
    resolvedTier: resolved.tier,
    reasons,
    warnings,
  };
}

function inc(map, key, count = 1) {
  map[key] = (map[key] || 0) + count;
}

function sampleEntry(entry, check = null) {
  const meta = parseMeta(entry.meta);
  const resolved = resolveVaultTier(entry);
  return {
    id: entry.id || null,
    title: entry.title || null,
    type: entry.type || null,
    source: entry.source || null,
    sourceKind: meta.sourceKind || null,
    sourceTable: meta.sourceTable || meta.source_ref?.table || null,
    filePath: entry.file_path || entry.filePath || null,
    tier: resolved.tier,
    reason: resolved.reason,
    hygieneReasons: check?.reasons || [],
  };
}

export function buildVaultTierReport(rows = [], options = {}) {
  const tierCounts = {};
  const typeTierCounts = {};
  const hygieneReasonCounts = {};
  const hygieneViolationSamples = [];
  const rawPromotionBlockedSamples = [];
  const sampleLimit = Math.max(1, Math.min(100, Number(options.sampleLimit) || 12));

  for (const row of rows || []) {
    const resolved = resolveVaultTier(row);
    inc(tierCounts, resolved.tier);
    inc(typeTierCounts, `${row.type || 'unknown'}:${resolved.tier}`);

    const currentCheck = knowledgeHygieneCheck(row, { targetTier: resolved.tier });
    if (!currentCheck.allowed) {
      for (const reason of currentCheck.reasons) inc(hygieneReasonCounts, reason);
      if (hygieneViolationSamples.length < sampleLimit) {
        hygieneViolationSamples.push(sampleEntry(row, currentCheck));
      }
    }

    if (resolved.tier === VAULT_TIERS.RAW_CORPUS) {
      const promotionCheck = knowledgeHygieneCheck(row, { targetTier: VAULT_TIERS.KNOWLEDGE });
      if (!promotionCheck.allowed && rawPromotionBlockedSamples.length < sampleLimit) {
        rawPromotionBlockedSamples.push(sampleEntry(row, promotionCheck));
      }
    }
  }

  const total = rows.length;
  return {
    enabled: true,
    mode: 'report_only',
    generatedAt: new Date().toISOString(),
    total,
    tierCounts,
    tierPercentages: Object.fromEntries(Object.entries(tierCounts).map(([tier, count]) => [
      tier,
      total ? Number(((count / total) * 100).toFixed(2)) : 0,
    ])),
    typeTierCounts,
    hygieneReasonCounts,
    hygieneViolationSamples,
    rawPromotionBlockedSamples,
    safety: {
      reportOnly: true,
      writes: false,
      envGate: 'SIGMA_VAULT_TIER_REPORT_ENABLED=true',
      ddlRequired: false,
    },
  };
}

export function isVaultTierReportEnabled(env = process.env) {
  return String(env.SIGMA_VAULT_TIER_REPORT_ENABLED || '').toLowerCase() === 'true';
}

export async function fetchVaultTierReport({
  queryReadonly,
  sampleLimit = 12,
} = {}) {
  if (typeof queryReadonly !== 'function') {
    throw new Error('queryReadonly_required');
  }
  const rows = await queryReadonly('sigma', `
    SELECT id::text, title, type, source, file_path, meta, abstraction_level, time_stage, validation_state, prediction_state, created_at
    FROM sigma.vault_entries
    WHERE COALESCE(status, 'captured') <> 'archived'
    ORDER BY created_at DESC, id DESC
  `, []);
  return buildVaultTierReport(rows, { sampleLimit });
}

export default {
  VAULT_TIERS,
  RAW_CORPUS_TYPES,
  KNOWLEDGE_TYPES,
  buildVaultTierReport,
  fetchVaultTierReport,
  hasSurprisingKnowledgeSignal,
  isRequeryableRawSource,
  isVaultTierReportEnabled,
  knowledgeHygieneCheck,
  resolveVaultTier,
};
