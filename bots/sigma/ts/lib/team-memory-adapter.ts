// @ts-nocheck
/**
 * team-memory-adapter.ts — Phase A: 9팀 4-Layer Memory 통합 어댑터
 *
 * 7-Layer Great Library Brain의 Layer 2 구현체.
 * 모든 팀에 동일한 인터페이스로 4-Layer Memory 제공.
 *
 * Layer 1 Working   : 호출자가 workingState 직접 전달
 * Layer 2 Short-term: sigma.agent_short_term_memory (TTL 24h)
 *                     Luna는 investment.agent_short_term_memory 라우팅
 * Layer 3 Episodic  : rag.agent_memory (episodic type)
 *                     Luna는 luna_rag_documents + luna_failure_reflexions 병행
 * Layer 4-Semantic  : sigma.entity_facts
 *                     Luna는 investment.entity_facts 라우팅
 * Layer 4-Procedural: packages/core/lib/skills/{team}/{agent}/ 파일
 *                     + rag.agent_memory (procedural type) 보완
 *
 * Kill Switch (기본 비활성):
 *   SIGMA_TEAM_MEMORY_UNIFIED=true  → 전체 활성
 *   SIGMA_TEAM_MEMORY_L2=false      → Layer 2 비활성
 *   SIGMA_TEAM_MEMORY_L3=false      → Layer 3 비활성
 *   SIGMA_TEAM_MEMORY_L4=false      → Layer 4 비활성
 */

import * as path from 'path';
import * as fs from 'fs';

const pgPool = require('../../../../packages/core/lib/pg-pool') as {
  run: (schema: string, sql: string, params?: unknown[]) => Promise<{ rowCount: number; rows: unknown[] }>;
  query: <T = unknown>(schema: string, sql: string, params?: unknown[]) => Promise<T[]>;
};

const { createAgentMemory } = require('../../../../packages/core/lib/agent-memory') as {
  createAgentMemory: (opts: { agentId: string; team: string }) => {
    remember: (content: string, type: 'episodic' | 'semantic' | 'procedural', opts?: Record<string, unknown>) => Promise<number | null>;
    recall: (query: string, opts?: { type?: string; limit?: number; threshold?: number }) => Promise<Array<{ content: string; similarity?: number; created_at: string }>>;
  };
};

const envModule = require('../../../../packages/core/lib/env') as { PROJECT_ROOT?: string };
const PROJECT_ROOT = envModule.PROJECT_ROOT || process.cwd();
const SKILLS_BASE = path.join(PROJECT_ROOT, 'packages/core/lib/skills');

// ─── Kill switches ───────────────────────────────────────────────────────────

const UNIFIED_ENABLED = process.env.SIGMA_TEAM_MEMORY_UNIFIED === 'true';
const L2_ENABLED = process.env.SIGMA_TEAM_MEMORY_L2 !== 'false';
const L3_ENABLED = process.env.SIGMA_TEAM_MEMORY_L3 !== 'false';
const L4_ENABLED = process.env.SIGMA_TEAM_MEMORY_L4 !== 'false';

// ─── Luna 라우팅 ─────────────────────────────────────────────────────────────

const LUNA_TEAMS = new Set(['luna', 'investment']);

function isLunaTeam(team: string): boolean {
  return LUNA_TEAMS.has(team);
}

// ─── Schema 초기화 ───────────────────────────────────────────────────────────

let schemaReady = false;

async function ensureSigmaSchema(): Promise<void> {
  if (schemaReady) return;
  await pgPool.run('sigma', `
    CREATE TABLE IF NOT EXISTS sigma.agent_short_term_memory (
      id BIGSERIAL PRIMARY KEY,
      team TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      content JSONB NOT NULL DEFAULT '{}',
      context JSONB NOT NULL DEFAULT '{}',
      expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgPool.run('sigma', `
    CREATE INDEX IF NOT EXISTS idx_sigma_stm_team_agent
    ON sigma.agent_short_term_memory (team, agent_name, expires_at)
  `);
  await pgPool.run('sigma', `
    CREATE TABLE IF NOT EXISTS sigma.entity_facts (
      id BIGSERIAL PRIMARY KEY,
      team TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      entity TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT 'general',
      fact TEXT NOT NULL,
      confidence NUMERIC(4,3) NOT NULL DEFAULT 0.700,
      source_event_id BIGINT,
      valid_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (team, agent_name, entity, entity_type)
    )
  `);
  await pgPool.run('sigma', `
    CREATE INDEX IF NOT EXISTS idx_sigma_ef_team_entity
    ON sigma.entity_facts (team, agent_name, entity, confidence DESC)
  `);
  schemaReady = true;
}

// ─── 공개 타입 ───────────────────────────────────────────────────────────────

export interface ShortTermEntry {
  id: number;
  team: string;
  agentName: string;
  content: unknown;
  context: unknown;
  createdAt: Date;
}

export interface FullPrefixResult {
  prefix: string;
  layers: {
    shortTerm: number;
    episodic: number;
    failures: number;
    skills: number;
    entityFacts: number;
    workingState: boolean;
  };
  totalChars: number;
}

export interface SaveShortTermOpts {
  ttlHours?: number;
  context?: Record<string, unknown>;
}

export interface SaveEntityFactOpts {
  confidence?: number;
  sourceEventId?: number;
  entityType?: string;
  validUntil?: Date | null;
}

export interface TeamMemoryAdapter {
  saveShortTerm(content: unknown, opts?: SaveShortTermOpts): Promise<void>;
  saveEpisodic(content: string, opts?: { importance?: number; keywords?: string[] }): Promise<void>;
  saveSemantic(entity: string, fact: string, opts?: SaveEntityFactOpts): Promise<void>;
  saveProcedural(content: string, opts?: { keywords?: string[] }): Promise<void>;
  getShortTerm(opts?: { limit?: number }): Promise<ShortTermEntry[]>;
  getEpisodic(query: string, opts?: { limit?: number }): Promise<string[]>;
  getSemantic(entity: string, opts?: { limit?: number; minConfidence?: number }): Promise<string[]>;
  getProcedural(query: string, opts?: { limit?: number }): Promise<string[]>;
  getFullPrefix(opts: { query: string; workingState?: string; maxChars?: number }): Promise<FullPrefixResult>;
}

// ─── Layer 2: Short-term ─────────────────────────────────────────────────────

async function _saveShortTerm(
  team: string,
  agentName: string,
  content: unknown,
  opts: SaveShortTermOpts = {},
): Promise<void> {
  const ttlHours = opts.ttlHours ?? 24;
  const context = opts.context ?? {};

  if (isLunaTeam(team)) {
    await pgPool.run('investment', `
      INSERT INTO investment.agent_short_term_memory
        (agent_name, content, expires_at)
      VALUES ($1, $2, NOW() + ($3 || ' hours')::INTERVAL)
    `, [agentName, JSON.stringify({ data: content, context }), String(ttlHours)]);
    return;
  }

  await ensureSigmaSchema();
  await pgPool.run('sigma', `
    INSERT INTO sigma.agent_short_term_memory
      (team, agent_name, content, context, expires_at)
    VALUES ($1, $2, $3, $4, NOW() + ($5 || ' hours')::INTERVAL)
  `, [team, agentName, JSON.stringify(content), JSON.stringify(context), String(ttlHours)]);
}

async function _getShortTerm(
  team: string,
  agentName: string,
  limit: number,
): Promise<ShortTermEntry[]> {
  if (isLunaTeam(team)) {
    type LunaStmRow = { id: number; agent_name: string; content: unknown; created_at: string };
    const rows = await pgPool.query<LunaStmRow>('investment', `
      SELECT id, agent_name, content, created_at
      FROM investment.agent_short_term_memory
      WHERE agent_name = $1 AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT $2
    `, [agentName, limit]);
    return rows.map(r => ({
      id: r.id,
      team,
      agentName: r.agent_name,
      content: r.content,
      context: {},
      createdAt: new Date(r.created_at),
    }));
  }

  await ensureSigmaSchema();
  type SigmaStmRow = { id: number; team: string; agent_name: string; content: unknown; context: unknown; created_at: string };
  const rows = await pgPool.query<SigmaStmRow>('sigma', `
    SELECT id, team, agent_name, content, context, created_at
    FROM sigma.agent_short_term_memory
    WHERE team = $1 AND agent_name = $2 AND expires_at > NOW()
    ORDER BY created_at DESC
    LIMIT $3
  `, [team, agentName, limit]);
  return rows.map(r => ({
    id: r.id,
    team: r.team,
    agentName: r.agent_name,
    content: r.content,
    context: r.context,
    createdAt: new Date(r.created_at),
  }));
}

// ─── Layer 3: Episodic ───────────────────────────────────────────────────────

async function _saveEpisodic(
  team: string,
  agentName: string,
  content: string,
  opts: { importance?: number; keywords?: string[] } = {},
): Promise<void> {
  const mem = createAgentMemory({ agentId: agentName, team });
  await mem.remember(content, 'episodic', {
    importance: opts.importance ?? 0.5,
    keywords: opts.keywords ?? [],
  });
}

async function _getEpisodic(
  team: string,
  agentName: string,
  query: string,
  limit: number,
): Promise<string[]> {
  if (isLunaTeam(team)) {
    try {
      type LunaRagRow = { content: string; category: string; market: string | null };
      const rows = await pgPool.query<LunaRagRow>('investment', `
        SELECT content, category, market
        FROM luna_rag_documents
        WHERE category IN ('thesis', 'trade_review')
          AND (owner_agent IS NULL OR owner_agent = $1)
        ORDER BY created_at DESC
        LIMIT $2
      `, [agentName, limit]);
      if (rows.length > 0) {
        return rows.map(r => `[${r.category}/${r.market ?? '?'}] ${String(r.content).slice(0, 200)}`);
      }
    } catch {
      // investment DB 미접근 시 rag.agent_memory로 fallback
    }
  }

  const mem = createAgentMemory({ agentId: agentName, team });
  const rows = await mem.recall(query, { type: 'episodic', limit });
  return rows.map(r => String(r.content).slice(0, 200));
}

async function _getFailures(
  team: string,
  agentName: string,
  query: string,
  limit: number,
): Promise<string[]> {
  if (isLunaTeam(team)) {
    try {
      type LunaRefRow = { hindsight: string };
      const rows = await pgPool.query<LunaRefRow>('investment', `
        SELECT hindsight
        FROM luna_failure_reflexions
        WHERE hindsight IS NOT NULL
        ORDER BY created_at DESC
        LIMIT $1
      `, [limit]);
      if (rows.length > 0) {
        return rows.map(r => String(r.hindsight).slice(0, 200));
      }
    } catch {
      // fallback
    }
  }

  // 공통: rag.agent_memory에서 낮은 importance 기록 (실패 패턴 추정)
  const mem = createAgentMemory({ agentId: agentName, team });
  const rows = await mem.recall(`${query} 실패 오류`, { type: 'episodic', limit });
  return rows
    .filter(r => Number(r.similarity ?? 1) < 0.85)
    .map(r => String(r.content).slice(0, 200));
}

// ─── Layer 4-Semantic: Entity Facts ─────────────────────────────────────────

async function _saveEntityFact(
  team: string,
  agentName: string,
  entity: string,
  fact: string,
  opts: SaveEntityFactOpts = {},
): Promise<void> {
  const confidence = Math.min(1, Math.max(0, opts.confidence ?? 0.7));
  const entityType = opts.entityType ?? 'general';
  const sourceEventId = opts.sourceEventId ?? null;
  const validUntil = opts.validUntil ?? null;

  if (isLunaTeam(team)) {
    await pgPool.run('investment', `
      INSERT INTO investment.entity_facts
        (entity, entity_type, fact, confidence, valid_until)
      VALUES ($1, $2, $3, $4, $5)
    `, [entity, entityType, fact, confidence, validUntil]);
    return;
  }

  await ensureSigmaSchema();
  await pgPool.run('sigma', `
    INSERT INTO sigma.entity_facts
      (team, agent_name, entity, entity_type, fact, confidence, source_event_id, valid_until)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (team, agent_name, entity, entity_type) DO UPDATE
      SET fact = EXCLUDED.fact,
          confidence = EXCLUDED.confidence,
          source_event_id = EXCLUDED.source_event_id,
          updated_at = NOW()
  `, [team, agentName, entity, entityType, fact, confidence, sourceEventId, validUntil]);
}

async function _getEntityFacts(
  team: string,
  agentName: string,
  entity: string,
  limit: number,
  minConfidence: number,
): Promise<string[]> {
  if (isLunaTeam(team)) {
    type LunaFactRow = { entity: string; fact: string; confidence: number };
    const rows = await pgPool.query<LunaFactRow>('investment', `
      SELECT entity, fact, confidence
      FROM investment.entity_facts
      WHERE entity = $1
        AND confidence >= $2
        AND (valid_until IS NULL OR valid_until > NOW())
      ORDER BY confidence DESC
      LIMIT $3
    `, [entity, minConfidence, limit]);
    return rows.map(r => `[${r.entity}] ${r.fact} (신뢰도: ${r.confidence})`);
  }

  await ensureSigmaSchema();
  type SigmaFactRow = { entity: string; entity_type: string; fact: string; confidence: number };
  const rows = await pgPool.query<SigmaFactRow>('sigma', `
    SELECT entity, entity_type, fact, confidence
    FROM sigma.entity_facts
    WHERE team = $1
      AND agent_name = $2
      AND entity = $3
      AND confidence >= $4
      AND (valid_until IS NULL OR valid_until > NOW())
    ORDER BY confidence DESC
    LIMIT $5
  `, [team, agentName, entity, minConfidence, limit]);
  return rows.map(r => `[${r.entity}/${r.entity_type}] ${r.fact} (신뢰도: ${r.confidence})`);
}

// ─── Layer 4-Procedural: Skills ──────────────────────────────────────────────

function _loadSkillFiles(team: string, agentName: string, query: string, limit: number): string[] {
  const skillDir = path.join(SKILLS_BASE, team, agentName);
  if (!fs.existsSync(skillDir)) return [];
  try {
    const files = fs.readdirSync(skillDir)
      .filter(f => f.endsWith('.md') && (f.startsWith('SUCCESS_') || f.startsWith('AVOID_')));

    const queryWords = query.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = files
      .map(f => ({
        file: f,
        score: queryWords.filter(w => f.toLowerCase().includes(w)).length,
      }))
      .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

    return scored.slice(0, limit).flatMap(({ file }) => {
      try {
        const content = fs.readFileSync(path.join(skillDir, file), 'utf-8');
        const firstLine = content.split('\n').find(l => l.trim()) ?? file;
        const prefix = file.startsWith('SUCCESS_') ? '✅' : '⚠️';
        return [`${prefix} ${firstLine.replace(/^#+\s*/, '').slice(0, 150)}`];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

async function _saveProcedural(
  team: string,
  agentName: string,
  content: string,
  opts: { keywords?: string[] } = {},
): Promise<void> {
  const mem = createAgentMemory({ agentId: agentName, team });
  await mem.remember(content, 'procedural', {
    importance: 0.8,
    keywords: opts.keywords ?? [],
  });
}

async function _getProcedural(
  team: string,
  agentName: string,
  query: string,
  limit: number,
): Promise<string[]> {
  const fromFiles = _loadSkillFiles(team, agentName, query, limit);
  if (fromFiles.length >= limit) return fromFiles;

  const remaining = limit - fromFiles.length;
  const mem = createAgentMemory({ agentId: agentName, team });
  const rows = await mem.recall(query, { type: 'procedural', limit: remaining });
  const fromRag = rows.map(r => `📘 ${String(r.content).slice(0, 150)}`);

  return [...fromFiles, ...fromRag];
}

// ─── getFullPrefix ───────────────────────────────────────────────────────────

async function _getFullPrefix(
  team: string,
  agentName: string,
  opts: { query: string; workingState?: string; maxChars?: number },
): Promise<FullPrefixResult> {
  const maxChars = opts.maxChars ?? 8_000;
  const sections: string[] = [];
  const layers: FullPrefixResult['layers'] = {
    shortTerm: 0,
    episodic: 0,
    failures: 0,
    skills: 0,
    entityFacts: 0,
    workingState: false,
  };

  const [stmResult, episodicResult, failuresResult, proceduralResult] =
    await Promise.allSettled([
      L2_ENABLED ? _getShortTerm(team, agentName, 3) : Promise.resolve([]),
      L3_ENABLED ? _getEpisodic(team, agentName, opts.query, 3) : Promise.resolve([]),
      L3_ENABLED ? _getFailures(team, agentName, opts.query, 2) : Promise.resolve([]),
      L4_ENABLED ? _getProcedural(team, agentName, opts.query, 2) : Promise.resolve([]),
    ]);

  const shortTerm = stmResult.status === 'fulfilled' ? stmResult.value : [];
  if (shortTerm.length > 0) {
    const items = shortTerm.map(m => {
      const summary = typeof m.content === 'string'
        ? m.content.slice(0, 150)
        : JSON.stringify(m.content).slice(0, 150);
      return `- [${m.agentName}] ${summary}`;
    }).join('\n');
    sections.push(`## 24h 단기 컨텍스트 (Layer 2)\n${items}`);
    layers.shortTerm = shortTerm.length;
  }

  const episodic = episodicResult.status === 'fulfilled' ? episodicResult.value : [];
  if (episodic.length > 0) {
    sections.push(`## 유사 과거 경험 (Layer 3 Episodic)\n${episodic.map(e => `- ${e}`).join('\n')}`);
    layers.episodic = episodic.length;
  }

  const failures = failuresResult.status === 'fulfilled' ? failuresResult.value : [];
  if (failures.length > 0) {
    sections.push(
      `## 유사 실패 회고 (Layer 3 Reflexion)\n${failures.map(f => `- [실패] ${f}`).join('\n')}` +
      '\n→ 위 패턴 재현 시 신중하게 검토하세요.',
    );
    layers.failures = failures.length;
  }

  const skills = proceduralResult.status === 'fulfilled' ? proceduralResult.value : [];
  if (skills.length > 0) {
    sections.push(`## 검증된 스킬 (Layer 4 Procedural)\n${skills.map(s => `- ${s}`).join('\n')}`);
    layers.skills = skills.length;
  }

  if (opts.workingState) {
    sections.push(`## 현재 작업 상태 (Layer 1 Working)\n${opts.workingState}`);
    layers.workingState = true;
  }

  let prefix = sections.join('\n\n---\n\n');
  if (prefix.length > maxChars) {
    prefix = `${prefix.slice(0, maxChars)}\n\n[메모리 컨텍스트 길이 제한으로 일부 생략]`;
  }

  return { prefix, layers, totalChars: prefix.length };
}

// ─── No-op 어댑터 (kill switch 비활성 시) ───────────────────────────────────

const EMPTY_PREFIX: FullPrefixResult = {
  prefix: '',
  layers: { shortTerm: 0, episodic: 0, failures: 0, skills: 0, entityFacts: 0, workingState: false },
  totalChars: 0,
};

function _noopAdapter(): TeamMemoryAdapter {
  return {
    saveShortTerm: async () => {},
    saveEpisodic: async () => {},
    saveSemantic: async () => {},
    saveProcedural: async () => {},
    getShortTerm: async () => [],
    getEpisodic: async () => [],
    getSemantic: async () => [],
    getProcedural: async () => [],
    getFullPrefix: async () => ({ ...EMPTY_PREFIX, layers: { ...EMPTY_PREFIX.layers } }),
  };
}

// ─── 공개 API ────────────────────────────────────────────────────────────────

/**
 * 팀별 4-Layer Memory 어댑터 생성.
 * SIGMA_TEAM_MEMORY_UNIFIED=true 로 활성화 (기본 비활성 — Kill Switch).
 */
export function createTeamMemory(team: string, agentName: string): TeamMemoryAdapter {
  const t = String(team || '').toLowerCase();
  const a = String(agentName || '').toLowerCase();

  if (!UNIFIED_ENABLED) return _noopAdapter();

  return {
    async saveShortTerm(content, opts = {}) {
      try {
        await _saveShortTerm(t, a, content, opts);
      } catch (err) {
        console.warn(`[team-memory:${t}:${a}] L2 save 실패:`, err);
      }
    },

    async saveEpisodic(content, opts = {}) {
      try {
        await _saveEpisodic(t, a, content, opts);
      } catch (err) {
        console.warn(`[team-memory:${t}:${a}] L3 episodic save 실패:`, err);
      }
    },

    async saveSemantic(entity, fact, opts = {}) {
      try {
        await _saveEntityFact(t, a, entity, fact, opts);
      } catch (err) {
        console.warn(`[team-memory:${t}:${a}] L4-S save 실패:`, err);
      }
    },

    async saveProcedural(content, opts = {}) {
      try {
        await _saveProcedural(t, a, content, opts);
      } catch (err) {
        console.warn(`[team-memory:${t}:${a}] L4-P save 실패:`, err);
      }
    },

    async getShortTerm(opts = {}) {
      try {
        return await _getShortTerm(t, a, opts.limit ?? 5);
      } catch (err) {
        console.warn(`[team-memory:${t}:${a}] L2 get 실패:`, err);
        return [];
      }
    },

    async getEpisodic(query, opts = {}) {
      try {
        return await _getEpisodic(t, a, query, opts.limit ?? 3);
      } catch (err) {
        console.warn(`[team-memory:${t}:${a}] L3 episodic get 실패:`, err);
        return [];
      }
    },

    async getSemantic(entity, opts = {}) {
      try {
        return await _getEntityFacts(t, a, entity, opts.limit ?? 5, opts.minConfidence ?? 0.5);
      } catch (err) {
        console.warn(`[team-memory:${t}:${a}] L4-S get 실패:`, err);
        return [];
      }
    },

    async getProcedural(query, opts = {}) {
      try {
        return await _getProcedural(t, a, query, opts.limit ?? 2);
      } catch (err) {
        console.warn(`[team-memory:${t}:${a}] L4-P get 실패:`, err);
        return [];
      }
    },

    async getFullPrefix(opts) {
      try {
        const result = await _getFullPrefix(t, a, opts);
        if (result.totalChars > 0) {
          console.log(
            `[team-memory:${t}:${a}] prefix=${result.totalChars}자 ` +
            `L2=${result.layers.shortTerm} ` +
            `L3=${result.layers.episodic}+${result.layers.failures}fail ` +
            `L4=${result.layers.skills}skills+${result.layers.entityFacts}facts ` +
            `L1=${result.layers.workingState}`,
          );
        }
        return result;
      } catch (err) {
        console.warn(`[team-memory:${t}:${a}] getFullPrefix 실패:`, err);
        return { ...EMPTY_PREFIX, layers: { ...EMPTY_PREFIX.layers } };
      }
    },
  };
}

/**
 * systemPrompt에 4-Layer Memory prefix를 주입.
 * SIGMA_TEAM_MEMORY_UNIFIED=true 가 아니면 원래 systemPrompt 그대로.
 */
export async function injectTeamMemory(
  systemPrompt: string,
  team: string,
  agentName: string,
  opts: { query: string; workingState?: string; maxChars?: number },
): Promise<string> {
  const adapter = createTeamMemory(team, agentName);
  const result = await adapter.getFullPrefix(opts);
  if (!result.prefix) return systemPrompt;
  return `${result.prefix}\n\n---\n\n${systemPrompt}`;
}
