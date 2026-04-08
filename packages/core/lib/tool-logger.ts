import pgPool = require('./pg-pool');
import env = require('./env');

type ToolMetadata = Record<string, unknown>;

type ToolLogOptions = {
  bot?: string;
  success?: boolean;
  duration_ms?: number;
  error?: string | null;
  metadata?: ToolMetadata;
};

type RecentCallOptions = {
  bot?: string;
  tool_name?: string;
  limit?: number;
};

type TraceModule = {
  getTraceId?: () => string | null;
};

const DEV_HUB_READONLY = env.IS_DEV && !!env.HUB_BASE_URL && !process.env.PG_DIRECT;

let getTraceId: () => string | null = () => null;
try {
  const trace = require('./trace') as TraceModule;
  if (typeof trace.getTraceId === 'function') {
    getTraceId = trace.getTraceId;
  }
} catch {
  // trace.js 없으면 무시
}

async function logToolCall(
  tool_name: string,
  action: string,
  options: ToolLogOptions = {},
): Promise<void> {
  if (DEV_HUB_READONLY) return;
  const trace_id = getTraceId();

  try {
    await pgPool.query('reservation', `
      INSERT INTO reservation.tool_calls
        (trace_id, bot, tool_name, action, success, duration_ms, error, metadata, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    `, [
      trace_id || null,
      options.bot || 'unknown',
      tool_name,
      action,
      options.success !== false,
      options.duration_ms || 0,
      options.error || null,
      JSON.stringify(options.metadata || {}),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[tool-logger] 저장 실패 (무시):', message);
  }
}

function withToolLog(
  tool_name: string,
  action: string,
  bot: string,
  metadata: ToolMetadata = {},
): <T>(fn: () => Promise<T>) => Promise<T> {
  return async function <T>(fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      await logToolCall(tool_name, action, {
        bot,
        success: true,
        duration_ms: Date.now() - start,
        metadata,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await logToolCall(tool_name, action, {
        bot,
        success: false,
        duration_ms: Date.now() - start,
        error: message,
        metadata,
      });
      throw error;
    }
  };
}

async function getRecentCalls(options: RecentCallOptions = {}): Promise<unknown[]> {
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  let idx = 1;

  if (options.bot) {
    conditions.push(`bot = $${idx++}`);
    params.push(options.bot);
  }
  if (options.tool_name) {
    conditions.push(`tool_name = $${idx++}`);
    params.push(options.tool_name);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options.limit || 20;
  params.push(limit);

  try {
    return await pgPool.query('reservation', `
      SELECT trace_id, bot, tool_name, action, success, duration_ms, error, created_at
      FROM reservation.tool_calls
      ${where}
      ORDER BY created_at DESC
      LIMIT $${idx}
    `, params) as unknown[];
  } catch {
    return [];
  }
}

export = { logToolCall, withToolLog, getRecentCalls };
