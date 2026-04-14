import pgPool = require('./pg-pool');
import rag = require('./rag');

type MemoryType = 'episodic' | 'semantic' | 'procedural';

type AgentMemoryOptions = {
  agentId: string;
  team: string;
};

type RememberOptions = {
  keywords?: string[] | null;
  importance?: number;
  expiresIn?: number | null;
  metadata?: Record<string, unknown> | null;
};

type RecallOptions = {
  type?: MemoryType | null;
  limit?: number;
  threshold?: number | null;
};

type RecallTeamOptions = RecallOptions & {
  excludeSelf?: boolean;
};

type RecallHintOptions = RecallOptions & {
  title?: string | null;
  separator?: 'pipe' | 'newline';
};

type ConsolidateOptions = {
  olderThanDays?: number;
  limit?: number;
  sourceType?: Extract<MemoryType, 'episodic'>;
  targetType?: Extract<MemoryType, 'semantic'>;
};

type ConsolidateResult = {
  scanned: number;
  created: number;
  sourceIds: number[];
  memoryId: number | null;
};

type AgentMemoryRow = {
  id: number;
  agent_id: string;
  team: string;
  memory_type: MemoryType;
  content: string;
  keywords: string[] | null;
  importance: number | string | null;
  access_count: number | string | null;
  last_accessed: string | null;
  expires_at: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  similarity?: number;
};

const SCHEMA = 'rag';
const MEMORY_TYPES: MemoryType[] = ['episodic', 'semantic', 'procedural'];

function normalizeImportance(value?: number | null): number {
  const n = Number.isFinite(value as number) ? Number(value) : 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function normalizeLimit(value?: number): number {
  const n = Number(value || 10);
  if (!Number.isFinite(n) || n <= 0) return 10;
  return Math.min(Math.floor(n), 50);
}

function ensureMemoryType(type: MemoryType): void {
  if (!MEMORY_TYPES.includes(type)) {
    throw new Error(`invalid memory type: ${type}`);
  }
}

function normalizeOlderThanDays(value?: number): number {
  const n = Number(value || 30);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(Math.floor(n), 365);
}

function firstLine(value: string): string {
  return String(value || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
}

function extractHeadline(value: string, separator: 'pipe' | 'newline' = 'newline'): string {
  if (separator === 'pipe') {
    return String(value || '').split(' | ')[0] || '기록 없음';
  }
  return firstLine(value) || '패턴 요약 없음';
}

function formatRecallHint(rows: AgentMemoryRow[], opts: RecallHintOptions = {}): string {
  if (!rows || rows.length === 0) return '';
  const title = String(opts.title || '최근 기억');
  const separator = opts.separator || 'newline';
  const lines = rows.slice(0, normalizeLimit(opts.limit || 2)).map((row) => {
    const createdAt = row?.created_at ? String(row.created_at).slice(0, 10) : 'unknown';
    const similarity = Number(row?.similarity || 0);
    const headline = extractHeadline(String(row?.content || ''), separator);
    return `${createdAt} / 유사도 ${similarity.toFixed(2)} / ${headline}`;
  });
  return `\n${title}:\n- ${lines.join('\n- ')}`;
}

function summarizeMemories(rows: AgentMemoryRow[]): string {
  if (!rows.length) return '';

  const typeCounts = new Map<string, number>();
  const keywordCounts = new Map<string, number>();
  const highlights: string[] = [];

  for (const row of rows) {
    const sourceType = String(row.metadata?.type || row.memory_type || 'memory');
    typeCounts.set(sourceType, (typeCounts.get(sourceType) || 0) + 1);

    for (const keyword of row.keywords || []) {
      const k = String(keyword || '').trim();
      if (!k) continue;
      keywordCounts.set(k, (keywordCounts.get(k) || 0) + 1);
    }

    const headline = firstLine(row.content);
    if (headline && highlights.length < 5) {
      highlights.push(headline.slice(0, 140));
    }
  }

  const typeSummary = Array.from(typeCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([type, count]) => `${type} ${count}건`)
    .join(', ');
  const keywords = Array.from(keywordCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([keyword]) => keyword);

  return [
    `[통합 기억] ${rows.length}건의 episodic 기억 요약`,
    typeSummary ? `주요 유형: ${typeSummary}` : null,
    keywords.length ? `핵심 키워드: ${keywords.join(', ')}` : null,
    highlights.length ? `대표 사례: ${highlights.join(' | ')}` : null,
  ].filter(Boolean).join('\n');
}

async function ensureMemorySchema(): Promise<void> {
  await pgPool.run(SCHEMA, 'CREATE SCHEMA IF NOT EXISTS rag', []);
  await pgPool.run(SCHEMA, 'CREATE EXTENSION IF NOT EXISTS vector', []);
  await pgPool.run(SCHEMA, `
    CREATE TABLE IF NOT EXISTS rag.agent_memory (
      id SERIAL PRIMARY KEY,
      agent_id VARCHAR(50) NOT NULL,
      team VARCHAR(20) NOT NULL,
      memory_type VARCHAR(20) NOT NULL,
      content TEXT NOT NULL,
      keywords TEXT[] DEFAULT '{}',
      embedding vector(${rag.EMBED_DIM}),
      importance DOUBLE PRECISION DEFAULT 0.5,
      access_count INTEGER DEFAULT 0,
      last_accessed TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `, []);
  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_agent_memory_agent
    ON rag.agent_memory (agent_id)
  `, []);
  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_agent_memory_team
    ON rag.agent_memory (team)
  `, []);
  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_agent_memory_type
    ON rag.agent_memory (memory_type)
  `, []);
  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_agent_memory_importance
    ON rag.agent_memory (importance DESC)
  `, []);
  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_agent_memory_expires_at
    ON rag.agent_memory (expires_at)
  `, []);
  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_agent_memory_keywords
    ON rag.agent_memory USING gin (keywords)
  `, []);
  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_agent_memory_metadata
    ON rag.agent_memory USING gin (metadata)
  `, []);
  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_agent_memory_embedding
    ON rag.agent_memory USING hnsw (embedding vector_cosine_ops)
  `, []);
}

async function touchAccess(ids: number[]): Promise<void> {
  if (!ids.length) return;
  await pgPool.run(SCHEMA, `
    UPDATE rag.agent_memory
    SET
      access_count = access_count + 1,
      last_accessed = NOW(),
      updated_at = NOW()
    WHERE id = ANY($1::int[])
  `, [ids]);
}

class AgentMemory {
  readonly agentId: string;
  readonly team: string;

  constructor(opts: AgentMemoryOptions) {
    if (!opts?.agentId) throw new Error('AgentMemory: agentId is required');
    if (!opts?.team) throw new Error('AgentMemory: team is required');
    this.agentId = opts.agentId;
    this.team = opts.team;
  }

  async remember(content: string, type: MemoryType, opts: RememberOptions = {}): Promise<number | null> {
    ensureMemoryType(type);
    await ensureMemorySchema();

    const text = String(content || '').trim();
    if (!text) return null;

    const embedding = await rag.createEmbedding(text);
    const vecStr = `[${embedding.join(',')}]`;
    const expiresAt = opts.expiresIn
      ? new Date(Date.now() + Math.max(1, Number(opts.expiresIn)) * 1000).toISOString()
      : null;

    const rows = await pgPool.query<{ id: number }>(SCHEMA, `
      INSERT INTO rag.agent_memory (
        agent_id,
        team,
        memory_type,
        content,
        keywords,
        embedding,
        importance,
        expires_at,
        metadata,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8, $9, NOW())
      RETURNING id
    `, [
      this.agentId,
      this.team,
      type,
      text,
      opts.keywords || [],
      vecStr,
      normalizeImportance(opts.importance),
      expiresAt,
      JSON.stringify(opts.metadata || {}),
    ]);

    return rows[0]?.id ?? null;
  }

  async recall(query: string, opts: RecallOptions = {}): Promise<AgentMemoryRow[]> {
    await ensureMemorySchema();

    const text = String(query || '').trim();
    if (!text) return [];

    const embedding = await rag.createEmbedding(text);
    const vecStr = `[${embedding.join(',')}]`;
    const params: unknown[] = [this.agentId, vecStr];
    const where = [
      'agent_id = $1',
      '(expires_at IS NULL OR expires_at > NOW())',
    ];
    let idx = 3;

    if (opts.type) {
      ensureMemoryType(opts.type);
      where.push(`memory_type = $${idx++}`);
      params.push(opts.type);
    }
    if (opts.threshold !== null && opts.threshold !== undefined) {
      where.push(`1 - (embedding <=> $2::vector) >= $${idx++}`);
      params.push(opts.threshold);
    }

    params.push(normalizeLimit(opts.limit));
    const rows = await pgPool.query<AgentMemoryRow>(SCHEMA, `
      SELECT
        id,
        agent_id,
        team,
        memory_type,
        content,
        keywords,
        importance,
        access_count,
        last_accessed,
        expires_at,
        metadata,
        created_at,
        updated_at,
        1 - (embedding <=> $2::vector) AS similarity
      FROM rag.agent_memory
      WHERE ${where.join(' AND ')}
      ORDER BY embedding <=> $2::vector, importance DESC, created_at DESC
      LIMIT $${idx}
    `, params);

    await touchAccess(rows.map((row) => row.id));
    return rows;
  }

  async recallTeam(query: string, opts: RecallTeamOptions = {}): Promise<AgentMemoryRow[]> {
    await ensureMemorySchema();

    const text = String(query || '').trim();
    if (!text) return [];

    const embedding = await rag.createEmbedding(text);
    const vecStr = `[${embedding.join(',')}]`;
    const params: unknown[] = [this.team, vecStr];
    const where = [
      'team = $1',
      '(expires_at IS NULL OR expires_at > NOW())',
    ];
    let idx = 3;

    if (opts.excludeSelf) {
      where.push(`agent_id <> $${idx++}`);
      params.push(this.agentId);
    }
    if (opts.type) {
      ensureMemoryType(opts.type);
      where.push(`memory_type = $${idx++}`);
      params.push(opts.type);
    }
    if (opts.threshold !== null && opts.threshold !== undefined) {
      where.push(`1 - (embedding <=> $2::vector) >= $${idx++}`);
      params.push(opts.threshold);
    }

    params.push(normalizeLimit(opts.limit));
    const rows = await pgPool.query<AgentMemoryRow>(SCHEMA, `
      SELECT
        id,
        agent_id,
        team,
        memory_type,
        content,
        keywords,
        importance,
        access_count,
        last_accessed,
        expires_at,
        metadata,
        created_at,
        updated_at,
        1 - (embedding <=> $2::vector) AS similarity
      FROM rag.agent_memory
      WHERE ${where.join(' AND ')}
      ORDER BY embedding <=> $2::vector, importance DESC, created_at DESC
      LIMIT $${idx}
    `, params);

    await touchAccess(rows.map((row) => row.id));
    return rows;
  }

  async recallHint(query: string, opts: RecallHintOptions = {}): Promise<string> {
    const rows = await this.recall(query, opts);
    return formatRecallHint(rows, opts);
  }

  async consolidate(opts: ConsolidateOptions = {}): Promise<ConsolidateResult> {
    await ensureMemorySchema();

    const sourceType = opts.sourceType || 'episodic';
    const targetType = opts.targetType || 'semantic';
    ensureMemoryType(sourceType);
    ensureMemoryType(targetType);

    const olderThanDays = normalizeOlderThanDays(opts.olderThanDays);
    const limit = normalizeLimit(opts.limit || 20);

    const rows = await pgPool.query<AgentMemoryRow>(SCHEMA, `
      SELECT
        id,
        agent_id,
        team,
        memory_type,
        content,
        keywords,
        importance,
        access_count,
        last_accessed,
        expires_at,
        metadata,
        created_at,
        updated_at
      FROM rag.agent_memory
      WHERE
        agent_id = $1
        AND team = $2
        AND memory_type = $3
        AND created_at < NOW() - ($4::text || ' days')::interval
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY importance DESC, created_at ASC
      LIMIT $5
    `, [this.agentId, this.team, sourceType, String(olderThanDays), limit]);

    if (!rows.length) {
      return { scanned: 0, created: 0, sourceIds: [], memoryId: null };
    }

    const keywordSet = new Set<string>();
    for (const row of rows) {
      for (const keyword of row.keywords || []) {
        const k = String(keyword || '').trim();
        if (k) keywordSet.add(k);
      }
    }

    const summary = summarizeMemories(rows);
    const memoryId = await this.remember(summary, targetType, {
      keywords: Array.from(keywordSet).slice(0, 12),
      importance: 0.72,
      metadata: {
        consolidatedFrom: sourceType,
        sourceIds: rows.map((row) => row.id),
        sourceCount: rows.length,
        olderThanDays,
        sourceCreatedAt: {
          first: rows[0]?.created_at || null,
          last: rows[rows.length - 1]?.created_at || null,
        },
      },
    });

    return {
      scanned: rows.length,
      created: memoryId ? 1 : 0,
      sourceIds: rows.map((row) => row.id),
      memoryId,
    };
  }
}

function createAgentMemory(opts: AgentMemoryOptions): AgentMemory {
  return new AgentMemory(opts);
}

export = {
  AgentMemory,
  createAgentMemory,
  ensureMemorySchema,
};
