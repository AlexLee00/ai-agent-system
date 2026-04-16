/**
 * /hub/memory — 에이전트 기억 저장/조회 엔드포인트
 *
 * POST /hub/memory/remember  — 에피소딕 기억 저장 (임베딩 포함)
 * POST /hub/memory/recall    — 유사도 기반 기억 조회
 */

const agentMemoryModule = require('../../../../packages/core/lib/agent-memory');

const { createAgentMemory } = agentMemoryModule;

const VALID_TYPES = ['episodic', 'semantic', 'procedural'] as const;
type MemoryType = (typeof VALID_TYPES)[number];

function normalizeString(value: unknown, fallback = ''): string {
  const s = String(value == null ? fallback : value).trim();
  return s || fallback;
}

function normalizeType(value: unknown): MemoryType {
  const s = normalizeString(value, 'episodic').toLowerCase() as MemoryType;
  return VALID_TYPES.includes(s) ? s : 'episodic';
}

function normalizeNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * POST /hub/memory/remember
 * Body: { agentId, team, content, type?, keywords?, importance?, metadata? }
 * Returns: { ok, memoryId }
 */
export async function memoryRememberRoute(req: any, res: any) {
  try {
    const agentId = normalizeString(req.body?.agentId);
    const team = normalizeString(req.body?.team);
    const content = normalizeString(req.body?.content);

    if (!agentId || !team || !content) {
      return res.status(400).json({ ok: false, error: 'agentId, team, content required' });
    }

    const type = normalizeType(req.body?.type);
    const keywords = Array.isArray(req.body?.keywords)
      ? req.body.keywords.map((k: unknown) => String(k || '').trim()).filter(Boolean)
      : null;
    const importance = req.body?.importance != null
      ? normalizeNumber(req.body.importance, 0.5)
      : undefined;
    const metadata = req.body?.metadata && typeof req.body.metadata === 'object'
      ? req.body.metadata
      : null;

    const mem = createAgentMemory({ agentId, team });
    const memoryId = await mem.remember(content, type, { keywords, importance, metadata });

    return res.json({ ok: true, memoryId });
  } catch (error: any) {
    console.error('[HubMemory] remember 실패:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
}

/**
 * POST /hub/memory/recall
 * Body: { agentId, team, query, type?, limit?, threshold? }
 * Returns: { ok, memories: AgentMemoryRow[] }
 */
export async function memoryRecallRoute(req: any, res: any) {
  try {
    const agentId = normalizeString(req.body?.agentId);
    const team = normalizeString(req.body?.team);
    const query = normalizeString(req.body?.query);

    if (!agentId || !team || !query) {
      return res.status(400).json({ ok: false, error: 'agentId, team, query required' });
    }

    const type = req.body?.type ? normalizeType(req.body.type) : undefined;
    const limit = req.body?.limit != null ? Math.min(normalizeNumber(req.body.limit, 5), 20) : 5;
    const threshold = req.body?.threshold != null
      ? normalizeNumber(req.body.threshold, 0.0)
      : undefined;

    const mem = createAgentMemory({ agentId, team });
    const memories = await mem.recall(query, { type, limit, threshold });

    return res.json({ ok: true, memories });
  } catch (error: any) {
    console.error('[HubMemory] recall 실패:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
}
