import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SIGMA_TEAMS = [
  'luna',
  'blog',
  'ska',
  'claude',
  'darwin',
  'justin',
  'sigma',
  'jay',
  'hub',
] as const;

export type SigmaTeam = (typeof SIGMA_TEAMS)[number];

export type LibraryMode = 'shadow' | 'supervised' | 'autonomous';

export interface SigmaLibraryEnv {
  SIGMA_TEAM_MEMORY_UNIFIED?: string;
  SIGMA_KNOWLEDGE_GRAPH_ENABLED?: string;
  SIGMA_DATASET_BUILDER_ENABLED?: string;
  SIGMA_SELF_IMPROVEMENT_ENABLED?: string;
  SIGMA_MULTI_HOP_RAG_ENABLED?: string;
  SIGMA_HYDE_ENABLED?: string;
  SIGMA_SELF_RAG_ENABLED?: string;
  SIGMA_DATA_LINEAGE_ENABLED?: string;
  SIGMA_PII_REDACTION_ENABLED?: string;
  SIGMA_SENSITIVE_EXPORT_BLOCKED?: string;
  SIGMA_CONSTITUTION_ENABLED?: string;
  SIGMA_CONSTITUTION_VIOLATION_AUTO_BLOCK?: string;
  SIGMA_LIBRARY_DASHBOARD_ENABLED?: string;
  SIGMA_LIBRARY_AUTONOMY_MODE?: string;
}

export interface LibraryGate {
  phase: string;
  enabled: boolean;
  defaultSafe: boolean;
  mode: LibraryMode;
  warnings: string[];
  blockers: string[];
}

export interface MemoryLayerPlan {
  team: SigmaTeam;
  working: string;
  shortTerm: string;
  episodic: string;
  semantic: string;
  procedural: string;
}

export interface GraphNode {
  id: string;
  tags: string[];
}

export interface GraphEdge {
  source: string;
  target: string;
  relationship: string;
  confidence: number;
  evidenceEventIds: number[];
}

export interface DatasetCard {
  team: SigmaTeam;
  dataset: string;
  format: 'jsonl' | 'parquet-plan';
  rows: number;
  schema: Record<string, string>;
  lineageRequired: boolean;
  externalExportBlocked: boolean;
}

export interface LineageRecord {
  dataId: string;
  sourceEventId: number | null;
  sourceTeam: string;
  sourceAgent: string;
  ingestedAt: string;
  processedBy: string[];
  consumedBy: string[];
  contentHash: string;
}

export interface SelfImprovementSignal {
  team: string;
  agent: string;
  outcome: 'success' | 'failure' | 'neutral';
  pattern: string;
  promptName?: string;
}

export interface SkillExtractionPlan {
  kind: 'SUCCESS' | 'AVOID';
  team: string;
  agent: string;
  pattern: string;
  support: number;
  fileName: string;
  promoted: false;
}

export interface DashboardSummary {
  ok: boolean;
  status: string;
  generatedAt: string;
  teams: number;
  datasets: number;
  graph: {
    nodes: number;
    edges: number;
    backlinks: number;
  };
  memoryCoverage: MemoryLayerPlan[];
  selfImprovement: {
    promptCandidates: number;
    skillCandidates: number;
    fineTuneCandidate: boolean;
  };
  gates: LibraryGate[];
  warnings: string[];
  blockers: string[];
}

const DEFAULT_MODE: LibraryMode = 'shadow';

function boolEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function modeEnv(value: string | undefined): LibraryMode {
  if (value === 'supervised' || value === 'autonomous') return value;
  return DEFAULT_MODE;
}

export function buildLibraryGates(env: SigmaLibraryEnv = process.env as SigmaLibraryEnv): LibraryGate[] {
  const mode = modeEnv(env.SIGMA_LIBRARY_AUTONOMY_MODE);
  return [
    ['A', 'SIGMA_TEAM_MEMORY_UNIFIED', false],
    ['B', 'SIGMA_KNOWLEDGE_GRAPH_ENABLED', false],
    ['C', 'SIGMA_DATASET_BUILDER_ENABLED', false],
    ['D', 'SIGMA_SELF_IMPROVEMENT_ENABLED', false],
    ['E1', 'SIGMA_MULTI_HOP_RAG_ENABLED', false],
    ['E2', 'SIGMA_HYDE_ENABLED', false],
    ['E3', 'SIGMA_SELF_RAG_ENABLED', false],
    ['F1', 'SIGMA_DATA_LINEAGE_ENABLED', false],
    ['F2', 'SIGMA_PII_REDACTION_ENABLED', true],
    ['F3', 'SIGMA_SENSITIVE_EXPORT_BLOCKED', true],
    ['G1', 'SIGMA_CONSTITUTION_ENABLED', true],
    ['G2', 'SIGMA_CONSTITUTION_VIOLATION_AUTO_BLOCK', false],
    ['H', 'SIGMA_LIBRARY_DASHBOARD_ENABLED', false],
  ].map(([phase, key, defaultValue]) => {
    const enabled = boolEnv(env[key as keyof SigmaLibraryEnv], Boolean(defaultValue));
    const blockers: string[] = [];
    if (mode === 'autonomous' && key === 'SIGMA_CONSTITUTION_ENABLED' && !enabled) {
      blockers.push('constitution_required_for_autonomous_mode');
    }
    return {
      phase: String(phase),
      enabled,
      defaultSafe: key === 'SIGMA_PII_REDACTION_ENABLED' || key === 'SIGMA_SENSITIVE_EXPORT_BLOCKED' || key === 'SIGMA_CONSTITUTION_ENABLED'
        ? enabled
        : !enabled,
      mode,
      warnings: enabled && mode === 'shadow' ? ['shadow_only_no_mutation'] : [],
      blockers,
    };
  });
}

export function buildMemoryLayerPlan(teams: readonly SigmaTeam[] = SIGMA_TEAMS): MemoryLayerPlan[] {
  return teams.map((team) => ({
    team,
    working: team === 'luna' ? 'investment working snapshot' : 'sigma session adapter',
    shortTerm: team === 'luna' ? 'investment.agent_short_term_memory' : 'sigma.agent_short_term_memory',
    episodic: team === 'luna' ? 'luna_rag_documents + agent_memory' : 'agent_memory episodic',
    semantic: team === 'luna' ? 'investment.entity_facts' : 'sigma.entity_facts',
    procedural: `skills/${team}/<agent>/SUCCESS_*.md + AVOID_*.md`,
  }));
}

export function extractEntities(text: string, limit = 12): GraphNode[] {
  const seen = new Set<string>();
  const tokens = String(text)
    .match(/[A-Za-z가-힣][A-Za-z가-힣0-9_-]{1,}/g) ?? [];
  const nodes: GraphNode[] = [];
  for (const token of tokens) {
    const normalized = token.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    nodes.push({ id: normalized, tags: inferTags(normalized) });
    if (nodes.length >= limit) break;
  }
  return nodes;
}

function inferTags(entity: string): string[] {
  const tags: string[] = [];
  if (/usdt|btc|trade|price|pnl/.test(entity)) tags.push('market');
  if (/blog|post|naver|instagram|facebook/.test(entity)) tags.push('content');
  if (/error|failure|incident|reconcile/.test(entity)) tags.push('incident');
  if (!tags.length) tags.push('general');
  return tags;
}

export function buildKnowledgeGraphFromTexts(texts: string[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodeMap = new Map<string, GraphNode>();
  const edgeMap = new Map<string, GraphEdge>();
  texts.forEach((text, index) => {
    const nodes = extractEntities(text);
    for (const node of nodes) nodeMap.set(node.id, node);
    for (let i = 0; i < nodes.length - 1; i += 1) {
      const source = nodes[i].id;
      const target = nodes[i + 1].id;
      const key = `${source}->${target}`;
      const existing = edgeMap.get(key);
      if (existing) {
        existing.confidence = Math.min(1, existing.confidence + 0.05);
        existing.evidenceEventIds.push(index + 1);
      } else {
        edgeMap.set(key, {
          source,
          target,
          relationship: 'related_to',
          confidence: 0.65,
          evidenceEventIds: [index + 1],
        });
      }
    }
  });
  return { nodes: [...nodeMap.values()], edges: [...edgeMap.values()] };
}

export function getBacklinks(entity: string, edges: GraphEdge[]): GraphEdge[] {
  const needle = entity.toLowerCase();
  return edges.filter((edge) => edge.target === needle);
}

export function getNeighbors(entity: string, edges: GraphEdge[], depth = 1): string[] {
  const visited = new Set<string>([entity.toLowerCase()]);
  let frontier = [entity.toLowerCase()];
  for (let currentDepth = 0; currentDepth < depth; currentDepth += 1) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const edge of edges) {
        if (edge.source === node && !visited.has(edge.target)) {
          visited.add(edge.target);
          next.push(edge.target);
        }
        if (edge.target === node && !visited.has(edge.source)) {
          visited.add(edge.source);
          next.push(edge.source);
        }
      }
    }
    frontier = next;
  }
  visited.delete(entity.toLowerCase());
  return [...visited].sort();
}

export function buildDatasetCards(teams: readonly SigmaTeam[] = SIGMA_TEAMS): DatasetCard[] {
  return teams.flatMap((team) => {
    const baseSchema = {
      source_event_id: 'number|null',
      team: 'string',
      agent: 'string',
      created_at: 'iso8601',
      payload: 'json',
      lineage_hash: 'sha256',
    };
    return [
      {
        team,
        dataset: `${team}_activity_weekly`,
        format: 'parquet-plan' as const,
        rows: 0,
        schema: baseSchema,
        lineageRequired: true,
        externalExportBlocked: true,
      },
      {
        team,
        dataset: `${team}_reflexion_weekly`,
        format: 'parquet-plan' as const,
        rows: 0,
        schema: { ...baseSchema, outcome: 'success|failure|neutral', lesson: 'string' },
        lineageRequired: true,
        externalExportBlocked: true,
      },
    ];
  });
}

export function redactPii(input: string): { text: string; redactions: string[] } {
  const redactions: string[] = [];
  let text = String(input);
  const replacements: Array<[RegExp, string, string]> = [
    [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]', 'email'],
    [/\b(?:\+?82[-.\s]?)?0?1[016789][-.\s]?\d{3,4}[-.\s]?\d{4}\b/g, '[REDACTED_PHONE]', 'phone'],
    [/\b(?:sk|pk|rk|ghp|glpat|xox[baprs])-?[A-Za-z0-9_\-]{16,}\b/g, '[REDACTED_TOKEN]', 'token'],
    [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]', 'jwt'],
  ];
  for (const [pattern, replacement, label] of replacements) {
    if (pattern.test(text)) {
      redactions.push(label);
      text = text.replace(pattern, replacement);
    }
  }
  return { text, redactions: [...new Set(redactions)] };
}

export function buildLineageRecord(input: {
  dataId: string;
  sourceEventId?: number | null;
  sourceTeam: string;
  sourceAgent: string;
  payload: unknown;
  processedBy?: string[];
  consumedBy?: string[];
}): LineageRecord {
  const stablePayload = JSON.stringify(input.payload ?? {});
  return {
    dataId: input.dataId,
    sourceEventId: input.sourceEventId ?? null,
    sourceTeam: input.sourceTeam,
    sourceAgent: input.sourceAgent,
    ingestedAt: new Date(0).toISOString(),
    processedBy: input.processedBy ?? ['sigma.library'],
    consumedBy: input.consumedBy ?? [],
    contentHash: crypto.createHash('sha256').update(stablePayload).digest('hex'),
  };
}

export function evaluateSensitiveExport(input: {
  collection: string;
  externalExport: boolean;
  masterApproved?: boolean;
}): { allowed: boolean; reason: string } {
  if (input.collection === 'rag_legal' && input.externalExport) {
    return { allowed: false, reason: 'rag_legal_absolute_isolation' };
  }
  if (input.externalExport && !input.masterApproved) {
    return { allowed: false, reason: 'external_dataset_export_requires_master_approval' };
  }
  return { allowed: true, reason: 'ok' };
}

export function planSelfImprovement(signals: SelfImprovementSignal[]): {
  promptCandidates: string[];
  skillCandidates: SkillExtractionPlan[];
  fineTuneCandidate: boolean;
} {
  const promptCandidates = [...new Set(signals
    .filter((signal) => signal.promptName && signal.outcome === 'success')
    .map((signal) => signal.promptName as string))]
    .sort();

  const grouped = new Map<string, SelfImprovementSignal[]>();
  for (const signal of signals) {
    const key = `${signal.outcome}:${signal.team}:${signal.agent}:${signal.pattern}`;
    grouped.set(key, [...(grouped.get(key) ?? []), signal]);
  }

  const skillCandidates: SkillExtractionPlan[] = [];
  for (const rows of grouped.values()) {
    const first = rows[0];
    if (!first) continue;
    const threshold = first.outcome === 'success' ? 5 : 3;
    if (first.outcome === 'neutral' || rows.length < threshold) continue;
    const kind = first.outcome === 'success' ? 'SUCCESS' : 'AVOID';
    const slug = first.pattern.toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'pattern';
    skillCandidates.push({
      kind,
      team: first.team,
      agent: first.agent,
      pattern: first.pattern,
      support: rows.length,
      fileName: `${kind}_${slug}.md`,
      promoted: false,
    });
  }

  return {
    promptCandidates,
    skillCandidates: skillCandidates.sort((a, b) => b.support - a.support || a.fileName.localeCompare(b.fileName)),
    fineTuneCandidate: signals.length >= 1_000,
  };
}

export const SIGMA_CONSTITUTION = [
  '모든 데이터는 9팀 모두를 위한 자산이다.',
  '데이터 lineage는 보존되어야 한다.',
  'RAG 저장 전 PII를 redaction한다.',
  'rag_legal은 외부 export하지 않는다.',
  '데이터셋 외부 공유는 마스터 승인을 요구한다.',
  'DPO fine-tuning은 후보 알림까지만 자동화한다.',
  '9팀 데이터는 동등하게 취급한다.',
];

export function evaluateConstitution(input: {
  collection?: string;
  text?: string;
  externalExport?: boolean;
  masterApproved?: boolean;
}): { allowed: boolean; critiques: string[]; redactedText: string } {
  const redacted = redactPii(input.text ?? '');
  const exportDecision = evaluateSensitiveExport({
    collection: input.collection ?? 'unknown',
    externalExport: Boolean(input.externalExport),
    masterApproved: Boolean(input.masterApproved),
  });
  const critiques = [
    ...redacted.redactions.map((item) => `pii_redacted:${item}`),
    ...(exportDecision.allowed ? [] : [exportDecision.reason]),
  ];
  return {
    allowed: exportDecision.allowed,
    critiques,
    redactedText: redacted.text,
  };
}

export function createDashboardSummary(input: {
  texts?: string[];
  signals?: SelfImprovementSignal[];
  env?: SigmaLibraryEnv;
} = {}): DashboardSummary {
  const gates = buildLibraryGates(input.env);
  const graph = buildKnowledgeGraphFromTexts(input.texts ?? []);
  const datasets = buildDatasetCards();
  const improvement = planSelfImprovement(input.signals ?? []);
  const blockers = gates.flatMap((gate) => gate.blockers);
  const warnings = gates.flatMap((gate) => gate.warnings);
  return {
    ok: blockers.length === 0,
    status: blockers.length === 0 ? 'sigma_library_contract_ready' : 'sigma_library_contract_blocked',
    generatedAt: new Date(0).toISOString(),
    teams: SIGMA_TEAMS.length,
    datasets: datasets.length,
    graph: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      backlinks: graph.edges.filter((edge) => edge.target).length,
    },
    memoryCoverage: buildMemoryLayerPlan(),
    selfImprovement: {
      promptCandidates: improvement.promptCandidates.length,
      skillCandidates: improvement.skillCandidates.length,
      fineTuneCandidate: improvement.fineTuneCandidate,
    },
    gates,
    warnings,
    blockers,
  };
}

export function writeDashboardJson(outPath: string, summary: DashboardSummary): string {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return outPath;
}
