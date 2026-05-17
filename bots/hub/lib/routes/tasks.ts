/**
 * /hub/tasks — Symphony Orchestrator 태스크 API
 *
 * POST  /hub/tasks       — 태스크 생성
 * GET   /hub/tasks       — 목록 조회 (status, team, limit, offset)
 * GET   /hub/tasks/:id   — 단건 조회
 * PATCH /hub/tasks/:id   — 상태/필드 업데이트 (상태 머신 적용)
 */

const pgPool = require('../../../../packages/core/lib/pg-pool');
const crypto = require('crypto');

const VALID_TEAMS = new Set(['claude', 'luna', 'blog', 'ska', 'darwin', 'sigma']);
const VALID_STATUSES = new Set(['todo', 'in_progress', 'review', 'done', 'blocked']);
const VALID_PRIORITIES = new Set(['low', 'normal', 'high']);
const VALID_SOURCES = new Set(['github', 'telegram', 'hub']);

// 허용된 상태 전환 (상태 머신)
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  todo:        ['in_progress', 'blocked'],
  in_progress: ['review', 'blocked', 'done'],
  review:      ['done', 'in_progress', 'blocked'],
  blocked:     ['todo', 'in_progress'],
  done:        [],
};

function generateTaskId(): string {
  return `task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function str(v: unknown, fallback = ''): string {
  return String(v == null ? fallback : v).trim() || fallback;
}

function intParam(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * POST /hub/tasks
 * Body: { source, target_team, title, body?, priority?, ticket_type?,
 *         source_ref?, ticket_external_id?, assignee?, metadata? }
 */
export async function tasksCreateRoute(req: any, res: any) {
  try {
    const source = str(req.body?.source);
    const target_team = str(req.body?.target_team);
    const title = str(req.body?.title);
    const body = str(req.body?.body);
    const priority = str(req.body?.priority, 'normal');
    const ticket_type = str(req.body?.ticket_type);
    const source_ref = str(req.body?.source_ref);
    const ticket_external_id = str(req.body?.ticket_external_id);
    const assignee = str(req.body?.assignee);
    const metadata = req.body?.metadata && typeof req.body.metadata === 'object'
      ? req.body.metadata
      : null;

    if (!source || !VALID_SOURCES.has(source)) {
      return res.status(400).json({ ok: false, error: `source 필수 (${[...VALID_SOURCES].join('|')})` });
    }
    if (!target_team || !VALID_TEAMS.has(target_team)) {
      return res.status(400).json({ ok: false, error: `target_team 필수 (${[...VALID_TEAMS].join('|')})` });
    }
    if (!title) {
      return res.status(400).json({ ok: false, error: 'title 필수' });
    }
    if (!VALID_PRIORITIES.has(priority)) {
      return res.status(400).json({ ok: false, error: `priority 오류 (${[...VALID_PRIORITIES].join('|')})` });
    }

    const id = generateTaskId();

    await pgPool.run('agent', `
      INSERT INTO symphony_tasks (
        id, source, target_team, ticket_type, title, body,
        priority, source_ref, ticket_external_id, assignee, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      source,
      target_team,
      ticket_type || null,
      title,
      body || null,
      priority,
      source_ref || null,
      ticket_external_id || null,
      assignee || null,
      metadata ? JSON.stringify(metadata) : null,
    ]);

    const task = await pgPool.get('agent', 'SELECT * FROM symphony_tasks WHERE id = ?', [id]);
    console.log(`[tasks] 생성: ${id} source=${source} team=${target_team} title="${title}"`);
    return res.status(201).json({ ok: true, task });
  } catch (err: any) {
    console.error('[tasks] create 실패:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * GET /hub/tasks
 * Query: status?, team?, limit?, offset?
 */
export async function tasksListRoute(req: any, res: any) {
  try {
    const status = str(req.query?.status);
    const team = str(req.query?.team);
    const limit = intParam(req.query?.limit, 50, 1, 200);
    const offset = intParam(req.query?.offset, 0, 0, 100000);

    const conditions: string[] = [];
    const filterParams: any[] = [];

    if (status && VALID_STATUSES.has(status)) {
      filterParams.push(status);
      conditions.push('status = ?');
    }
    if (team && VALID_TEAMS.has(team)) {
      filterParams.push(team);
      conditions.push('target_team = ?');
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const [rows, countRows] = await Promise.all([
      pgPool.query('agent', `
        SELECT * FROM symphony_tasks
        ${where}
        ORDER BY
          CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
          created_at ASC
        LIMIT ? OFFSET ?
      `, [...filterParams, limit, offset]),
      pgPool.query('agent', `
        SELECT COUNT(*)::int AS total FROM symphony_tasks ${where}
      `, filterParams),
    ]);

    return res.json({
      ok: true,
      tasks: rows,
      total: countRows[0]?.total ?? 0,
      limit,
      offset,
    });
  } catch (err: any) {
    console.error('[tasks] list 실패:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * GET /hub/tasks/:id
 */
export async function tasksDetailRoute(req: any, res: any) {
  try {
    const id = str(req.params?.id);
    if (!id) return res.status(400).json({ ok: false, error: 'id 필수' });

    const task = await pgPool.get('agent', 'SELECT * FROM symphony_tasks WHERE id = ?', [id]);
    if (!task) return res.status(404).json({ ok: false, error: 'task not found' });

    return res.json({ ok: true, task });
  } catch (err: any) {
    console.error('[tasks] detail 실패:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

/**
 * PATCH /hub/tasks/:id
 * Body: { status?, assignee?, workspace_id?, pr_url?, error_msg?, metadata? }
 */
export async function tasksPatchRoute(req: any, res: any) {
  try {
    const id = str(req.params?.id);
    if (!id) return res.status(400).json({ ok: false, error: 'id 필수' });

    const task = await pgPool.get('agent', 'SELECT * FROM symphony_tasks WHERE id = ?', [id]);
    if (!task) return res.status(404).json({ ok: false, error: 'task not found' });

    const updates: string[] = [];
    const params: any[] = [];

    const newStatus = req.body?.status !== undefined ? str(req.body.status) : '';
    if (newStatus) {
      if (!VALID_STATUSES.has(newStatus)) {
        return res.status(400).json({ ok: false, error: `status 오류 (${[...VALID_STATUSES].join('|')})` });
      }
      const allowed = ALLOWED_TRANSITIONS[task.status] ?? [];
      if (!allowed.includes(newStatus)) {
        return res.status(400).json({
          ok: false,
          error: `상태 전환 불가: ${task.status} → ${newStatus}`,
          allowed,
        });
      }
      updates.push('status = ?');
      params.push(newStatus);
    }

    const patchableFields: Array<[string, string]> = [
      ['assignee', 'assignee'],
      ['workspace_id', 'workspace_id'],
      ['pr_url', 'pr_url'],
      ['error_msg', 'error_msg'],
    ];
    for (const [bodyKey, colName] of patchableFields) {
      if (req.body?.[bodyKey] !== undefined) {
        updates.push(`${colName} = ?`);
        params.push(str(req.body[bodyKey]) || null);
      }
    }

    if (req.body?.metadata !== undefined && typeof req.body.metadata === 'object') {
      updates.push('metadata = ?');
      params.push(JSON.stringify(req.body.metadata));
    }

    if (updates.length === 0) {
      return res.status(400).json({ ok: false, error: '업데이트할 필드 없음' });
    }

    params.push(id);
    await pgPool.run('agent', `
      UPDATE symphony_tasks SET ${updates.join(', ')} WHERE id = ?
    `, params);

    const updated = await pgPool.get('agent', 'SELECT * FROM symphony_tasks WHERE id = ?', [id]);
    console.log(`[tasks] 업데이트: ${id} ${newStatus ? `status=${task.status}→${newStatus}` : ''}`);
    return res.json({ ok: true, task: updated });
  } catch (err: any) {
    console.error('[tasks] patch 실패:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
