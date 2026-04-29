// @ts-nocheck
/**
 * shared/agent-memory-orchestrator.ts — Phase B: 8종 컨텍스트 자동 prefix 조합기
 *
 * Generative Agents + MemGPT + LangChain Memory + Reflexion 통합.
 *
 * 8종 컨텍스트 (LLM 호출 직전 자동 prefix):
 *   1. agent_persona.md          (영구 정체성)
 *   2. agent_constitution.md     (원칙 list)
 *   3. similar_thesis (top 3)    (Layer 3 episodic — RAG)
 *   4. similar_failures (top 2)  (Reflexion 회피 — RAG)
 *   5. relevant_skills (top 2)   (Procedural — skill library)
 *   6. entity_facts (top 5)      (Semantic — entity_facts 테이블)
 *   7. recent_short_term (24h)   (Layer 2 — agent_short_term_memory)
 *   8. current_working_state     (Layer 1 — 호출자가 직접 전달)
 *
 * Kill Switch:
 *   LUNA_AGENT_MEMORY_AUTO_PREFIX=false → 전체 비활성 (원래 프롬프트 그대로)
 *   LUNA_AGENT_MEMORY_LAYER_2=false    → Layer 2 단기 메모리 비활성
 *   LUNA_AGENT_MEMORY_LAYER_3=false    → Layer 3 episodic 비활성
 *   LUNA_AGENT_MEMORY_LAYER_4=false    → Layer 4 semantic/procedural 비활성
 *   LUNA_AGENT_PERSONA_ENABLED=false   → 페르소나 주입 비활성
 *   LUNA_AGENT_CONSTITUTION_ENABLED=false → 헌법 주입 비활성
 */

import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';

const _require = createRequire(import.meta.url);
const pgPool = _require('../../../packages/core/lib/pg-pool');
const env = _require('../../../packages/core/lib/env');

const PROJECT_ROOT = env.PROJECT_ROOT || process.cwd();
const TEAM_DIR = path.join(PROJECT_ROOT, 'bots/investment/team');
const SKILLS_DIR = path.join(PROJECT_ROOT, 'packages/core/lib/skills/investment');

// Kill switch 헬퍼
const isEnabled = (envVar: string) => process.env[envVar] !== 'false';

// ─── 타입 ─────────────────────────────────────────────────────────────────────

export interface MemoryOrchestratorOptions {
  agentName: string;
  market?: string;
  symbol?: string;
  taskType?: string;
  incidentKey?: string;
  /** Layer 1: 현재 작업 상태 (호출자가 직접 전달) */
  workingState?: string;
  /** 최대 prefix 길이 (기본 8000자) — 컨텍스트 윈도우 보호 */
  maxPrefixChars?: number;
}

export interface OrchestratorResult {
  /** 조합된 최종 system prompt prefix */
  prefix: string;
  /** 각 레이어별 포함 여부 */
  layers: {
    persona: boolean;
    constitution: boolean;
    episodic: number;    // RAG 문서 수
    failures: number;    // 실패 패턴 수
    skills: number;      // 스킬 수
    entityFacts: number; // 엔티티 사실 수
    shortTerm: number;   // 단기 메모리 수
    workingState: boolean;
  };
  totalChars: number;
}

// ─── 메인 조합 함수 ───────────────────────────────────────────────────────────

/**
 * 8종 컨텍스트를 조합해 system prompt prefix 반환.
 * callLLMWithHub 직전에 systemPrompt = prefix + '\n\n' + originalSystemPrompt 로 사용.
 */
export async function buildMemoryPrefix(
  opts: MemoryOrchestratorOptions,
): Promise<OrchestratorResult> {
  const maxChars = opts.maxPrefixChars ?? 8_000;
  const sections: string[] = [];
  const layers = {
    persona: false,
    constitution: false,
    episodic: 0,
    failures: 0,
    skills: 0,
    entityFacts: 0,
    shortTerm: 0,
    workingState: false,
  };

  if (!isEnabled('LUNA_AGENT_MEMORY_AUTO_PREFIX')) {
    return { prefix: '', layers, totalChars: 0 };
  }

  // 1. Persona
  if (isEnabled('LUNA_AGENT_PERSONA_ENABLED')) {
    const persona = _loadMarkdownFile(TEAM_DIR, `${opts.agentName}.persona.md`);
    if (persona) {
      sections.push(`## 에이전트 정체성\n${persona}`);
      layers.persona = true;
    }
  }

  // 2. Constitution
  if (isEnabled('LUNA_AGENT_CONSTITUTION_ENABLED')) {
    const constitution = _loadMarkdownFile(TEAM_DIR, `${opts.agentName}.constitution.md`);
    if (constitution) {
      sections.push(`## 행동 원칙 (Constitution)\n${constitution}`);
      layers.constitution = true;
    }
  }

  // 3~6: DB 기반 레이어 병렬 조회
  const [episodicResult, failureResult, skillResult, entityResult, shortTermResult] = await Promise.allSettled([
    // 3. Layer 3 Episodic (RAG similar thesis)
    isEnabled('LUNA_AGENT_MEMORY_LAYER_3')
      ? _fetchEpisodicMemory(opts.agentName, opts.symbol, opts.market)
      : Promise.resolve([]),

    // 4. Layer 3 Failures (RAG similar failures)
    isEnabled('LUNA_AGENT_MEMORY_LAYER_3')
      ? _fetchFailureMemory(opts.agentName, opts.symbol, opts.market)
      : Promise.resolve([]),

    // 5. Layer 4 Procedural (skill files)
    isEnabled('LUNA_AGENT_MEMORY_LAYER_4')
      ? _fetchSkills(opts.agentName, opts.taskType, opts.market)
      : Promise.resolve([]),

    // 6. Layer 4 Semantic (entity_facts)
    isEnabled('LUNA_AGENT_MEMORY_LAYER_4') && opts.symbol
      ? _fetchEntityFacts(opts.symbol, opts.market)
      : Promise.resolve([]),

    // 7. Layer 2 Short-term
    isEnabled('LUNA_AGENT_MEMORY_LAYER_2')
      ? _fetchShortTermMemory(opts.agentName, opts.symbol, opts.market, opts.incidentKey)
      : Promise.resolve([]),
  ]);

  // 3. Episodic
  const episodic = episodicResult.status === 'fulfilled' ? episodicResult.value : [];
  if (episodic.length > 0) {
    const items = episodic.slice(0, 3).map((e: any) =>
      `- [${e.category}/${e.market || '?'}] ${e.content.slice(0, 200)}`
    ).join('\n');
    sections.push(`## 유사 과거 매매 (Episodic Memory)\n${items}`);
    layers.episodic = episodic.length;
  }

  // 4. Failures
  const failures = failureResult.status === 'fulfilled' ? failureResult.value : [];
  if (failures.length > 0) {
    const items = failures.slice(0, 2).map((f: any) =>
      `- [실패] ${(f.hindsight || f.content || '').slice(0, 200)}`
    ).join('\n');
    sections.push(`## 유사 실패 회고 (Reflexion)\n${items}\n→ 위 패턴 재현 시 신중하게 검토하세요.`);
    layers.failures = failures.length;
  }

  // 5. Skills
  const skills = skillResult.status === 'fulfilled' ? skillResult.value : [];
  if (skills.length > 0) {
    const items = skills.slice(0, 2).map((s: string) => `- ${s}`).join('\n');
    sections.push(`## 검증된 스킬 (Procedural Memory)\n${items}`);
    layers.skills = skills.length;
  }

  // 6. Entity Facts
  const entityFacts = entityResult.status === 'fulfilled' ? entityResult.value : [];
  if (entityFacts.length > 0) {
    const items = entityFacts.slice(0, 5).map((f: any) =>
      `- [${f.entity}] ${f.fact} (신뢰도: ${f.confidence})`
    ).join('\n');
    sections.push(`## 알려진 사실 (Semantic Memory)\n${items}`);
    layers.entityFacts = entityFacts.length;
  }

  // 7. Short-term
  const shortTerm = shortTermResult.status === 'fulfilled' ? shortTermResult.value : [];
  if (shortTerm.length > 0) {
    const items = shortTerm.slice(0, 3).map((m: any) => {
      const summary = typeof m.content === 'string'
        ? m.content.slice(0, 150)
        : JSON.stringify(m.content).slice(0, 150);
      return `- [${m.agent_name}/${m.symbol || '?'}] ${summary}`;
    }).join('\n');
    sections.push(`## 24h 단기 컨텍스트 (Short-term Memory)\n${items}`);
    layers.shortTerm = shortTerm.length;
  }

  // 8. Working State (Layer 1)
  if (opts.workingState) {
    sections.push(`## 현재 작업 상태 (Working Memory)\n${opts.workingState}`);
    layers.workingState = true;
  }

  // 조합 + 길이 제한
  let prefix = sections.join('\n\n---\n\n');
  if (prefix.length > maxChars) {
    prefix = prefix.slice(0, maxChars) + '\n\n[메모리 컨텍스트 길이 제한으로 일부 생략]';
  }

  return { prefix, layers, totalChars: prefix.length };
}

/**
 * systemPrompt에 memory prefix를 주입해 반환.
 * 빈 prefix면 원래 systemPrompt 그대로 반환.
 */
export async function injectMemoryIntoSystemPrompt(
  systemPrompt: string,
  opts: MemoryOrchestratorOptions,
): Promise<string> {
  const result = await buildMemoryPrefix(opts);
  if (!result.prefix) return systemPrompt;

  console.log(
    `[memory-orchestrator] ${opts.agentName} prefix=${result.totalChars}chars ` +
    `persona=${result.layers.persona} constitution=${result.layers.constitution} ` +
    `episodic=${result.layers.episodic} failures=${result.layers.failures} ` +
    `skills=${result.layers.skills} facts=${result.layers.entityFacts} ` +
    `shortTerm=${result.layers.shortTerm}`
  );

  return `${result.prefix}\n\n---\n\n${systemPrompt}`;
}

// ─── 단기 메모리 저장/조회 ────────────────────────────────────────────────────

export async function saveShortTermMemory(
  agentName: string,
  content: Record<string, unknown>,
  opts: { symbol?: string; market?: string; incidentKey?: string; ttlHours?: number } = {},
): Promise<void> {
  if (!isEnabled('LUNA_AGENT_MEMORY_LAYER_2')) return;
  try {
    const ttlHours = opts.ttlHours ?? 24;
    await pgPool.query(`
      INSERT INTO investment.agent_short_term_memory
        (agent_name, incident_key, symbol, market, content, expires_at)
      VALUES ($1, $2, $3, $4, $5, NOW() + $6::interval)
    `, [
      agentName,
      opts.incidentKey || null,
      opts.symbol || null,
      opts.market || null,
      JSON.stringify(content),
      `${ttlHours} hours`,
    ]);
  } catch (err) {
    console.warn(`[memory-orchestrator] 단기 메모리 저장 실패:`, err);
  }
}

// ─── 내부 조회 함수 ───────────────────────────────────────────────────────────

function _loadMarkdownFile(dir: string, filename: string): string | null {
  try {
    const filePath = path.join(dir, filename);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
    return null;
  } catch {
    return null;
  }
}

async function _fetchEpisodicMemory(
  agentName: string,
  symbol?: string,
  market?: string,
): Promise<any[]> {
  const filters: string[] = ["category IN ('thesis', 'trade_review')"];
  const params: unknown[] = [];
  let idx = 1;

  if (agentName) {
    filters.push(`(owner_agent = $${idx} OR owner_agent IS NULL)`);
    params.push(agentName);
    idx++;
  }
  if (symbol) {
    filters.push(`symbol = $${idx}`);
    params.push(symbol);
    idx++;
  }
  if (market) {
    filters.push(`market = $${idx}`);
    params.push(market);
    idx++;
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const result = await pgPool.query(`
    SELECT category, symbol, market, content, created_at
    FROM luna_rag_documents
    ${where}
    ORDER BY created_at DESC
    LIMIT 3
  `, params);

  return result.rows || [];
}

async function _fetchFailureMemory(
  agentName: string,
  symbol?: string,
  market?: string,
): Promise<any[]> {
  const params: unknown[] = [];
  let idx = 1;
  const filters: string[] = ["category = 'failure'"];

  if (symbol) {
    filters.push(`symbol = $${idx}`);
    params.push(symbol);
    idx++;
  }
  if (market) {
    filters.push(`market = $${idx}`);
    params.push(market);
    idx++;
  }

  const where = filters.join(' AND ');
  const result = await pgPool.query(`
    SELECT content, created_at
    FROM luna_rag_documents
    WHERE ${where}
    ORDER BY created_at DESC
    LIMIT 2
  `, params);

  // luna_failure_reflexions도 조합
  const reflexResult = await pgPool.query(`
    SELECT hindsight, avoid_pattern, created_at
    FROM investment.luna_failure_reflexions
    ORDER BY created_at DESC
    LIMIT 2
  `);

  return [
    ...(result.rows || []).map((r: any) => ({ content: r.content, created_at: r.created_at })),
    ...(reflexResult.rows || []).map((r: any) => ({
      hindsight: r.hindsight,
      content: r.hindsight || '',
      created_at: r.created_at,
    })),
  ].slice(0, 2);
}

async function _fetchSkills(agentName: string, taskType?: string, market?: string): Promise<string[]> {
  try {
    const marketKey = String(market || '').trim().toLowerCase();
    const dirCandidates = [
      path.join(SKILLS_DIR, agentName),
      path.join(SKILLS_DIR, 'luna', marketKey),
      path.join(SKILLS_DIR, 'luna'),
      SKILLS_DIR,
    ].filter((value, index, arr) => value && arr.indexOf(value) === index);

    const preferAvoid = String(taskType || '').toLowerCase().includes('risk')
      || String(taskType || '').toLowerCase().includes('guard')
      || String(taskType || '').toLowerCase().includes('exit');
    const prefixes = preferAvoid ? ['AVOID_', 'SUCCESS_'] : ['SUCCESS_', 'AVOID_'];

    const collected: string[] = [];
    for (const dirPath of dirCandidates) {
      if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) continue;
      const files = fs.readdirSync(dirPath)
        .filter((f) => f.endsWith('.md') && prefixes.some((prefix) => f.startsWith(prefix)))
        .sort((a, b) => a.localeCompare(b));
      for (const f of files) {
        const fullPath = path.join(dirPath, f);
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          collected.push(`[${f.replace('.md', '')}] ${content.split('\n')[0]}`);
        } catch {
          collected.push(f);
        }
        if (collected.length >= 2) return collected;
      }
    }
    return collected;
  } catch {
    return [];
  }
}

async function _fetchEntityFacts(symbol: string, market?: string): Promise<any[]> {
  try {
    const result = await pgPool.query(`
      SELECT entity, fact, confidence
      FROM investment.entity_facts
      WHERE
        entity = $1
        AND confidence >= 0.70
        AND (valid_until IS NULL OR valid_until > NOW())
      ORDER BY confidence DESC, created_at DESC
      LIMIT 5
    `, [symbol]);
    return result.rows || [];
  } catch {
    return [];
  }
}

async function _fetchShortTermMemory(
  agentName: string,
  symbol?: string,
  market?: string,
  incidentKey?: string,
): Promise<any[]> {
  try {
    const params: unknown[] = [agentName];
    let idx = 2;
    const extras: string[] = [];

    if (symbol) {
      extras.push(`symbol = $${idx}`);
      params.push(symbol);
      idx++;
    }
    if (incidentKey) {
      extras.push(`incident_key = $${idx}`);
      params.push(incidentKey);
      idx++;
    }

    const extraWhere = extras.length ? `AND (${extras.join(' OR ')})` : '';

    const result = await pgPool.query(`
      SELECT agent_name, symbol, market, content, created_at
      FROM investment.agent_short_term_memory
      WHERE
        agent_name = $1
        AND expires_at > NOW()
        ${extraWhere}
      ORDER BY created_at DESC
      LIMIT 3
    `, params);

    return result.rows || [];
  } catch {
    return [];
  }
}
