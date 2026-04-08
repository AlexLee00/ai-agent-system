import pgPool = require('./pg-pool');

type StoreRow = {
  data_type?: string;
  content?: string | null;
  node_id?: string;
};

async function ensureSchema(): Promise<void> {
  await pgPool.run('blog', `
    CREATE TABLE IF NOT EXISTS blog.pipeline_store (
      id         SERIAL,
      session_id TEXT NOT NULL,
      node_id    TEXT NOT NULL,
      node_group TEXT,
      data_type  TEXT NOT NULL DEFAULT 'json',
      content    TEXT,
      metadata   JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ,
      PRIMARY KEY (session_id, node_id)
    )
  `);

  await pgPool.run('blog', `
    CREATE INDEX IF NOT EXISTS idx_bps_session
      ON blog.pipeline_store(session_id)
  `);
}

async function storeNodeResult(sessionId: string, nodeId: string, nodeGroup: string, data: unknown): Promise<void> {
  const dataType = typeof data === 'string' ? 'text' : 'json';
  const content = dataType === 'text' ? data : JSON.stringify(data);

  await pgPool.run('blog', `
    INSERT INTO blog.pipeline_store
      (session_id, node_id, node_group, data_type, content, expires_at)
    VALUES
      ($1, $2, $3, $4, $5, NOW() + INTERVAL '7 days')
    ON CONFLICT (session_id, node_id) DO UPDATE SET
      node_group = EXCLUDED.node_group,
      data_type  = EXCLUDED.data_type,
      content    = EXCLUDED.content,
      created_at = NOW(),
      expires_at = NOW() + INTERVAL '7 days'
  `, [sessionId, nodeId, nodeGroup, dataType, content]);
}

async function getNodeResult(sessionId: string, nodeId: string): Promise<unknown | null> {
  const row = await pgPool.get('blog', `
    SELECT data_type, content
      FROM blog.pipeline_store
     WHERE session_id = $1
       AND node_id    = $2
       AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 1
  `, [sessionId, nodeId]) as StoreRow | null;

  if (!row || !row.content) return null;

  if (row.data_type === 'json') {
    try { return JSON.parse(row.content); } catch { return row.content; }
  }
  return row.content;
}

async function getSessionResults(sessionId: string): Promise<Record<string, unknown>> {
  const rows = await pgPool.query('blog', `
    SELECT node_id, data_type, content
      FROM blog.pipeline_store
     WHERE session_id = $1
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY created_at ASC
  `, [sessionId]) as StoreRow[];

  const result: Record<string, unknown> = {};
  for (const row of rows) {
    if (!row.content || !row.node_id) continue;
    if (row.data_type === 'json') {
      try { result[row.node_id] = JSON.parse(row.content); } catch { result[row.node_id] = row.content; }
    } else {
      result[row.node_id] = row.content;
    }
  }
  return result;
}

async function cleanupExpired(): Promise<number> {
  const r = await pgPool.run('blog', `
    DELETE FROM blog.pipeline_store
     WHERE expires_at IS NOT NULL
       AND expires_at < NOW()
  `);
  return r.rowCount || 0;
}

export = { ensureSchema, storeNodeResult, getNodeResult, getSessionResults, cleanupExpired };
