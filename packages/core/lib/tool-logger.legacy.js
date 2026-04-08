'use strict';

const pgPool = require('./pg-pool');
const env = require('./env');
const DEV_HUB_READONLY = env.IS_DEV && !!env.HUB_BASE_URL && !process.env.PG_DIRECT;

let _getTraceId = () => null;
try {
  const trace = require('./trace');
  _getTraceId = trace.getTraceId;
} catch (e) {
  // trace.js 없으면 무시
}

async function logToolCall(tool_name, action, options = {}) {
  if (DEV_HUB_READONLY) return;
  const trace_id = _getTraceId();

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
  } catch (e) {
    console.warn('[tool-logger] 저장 실패 (무시):', e.message);
  }
}

function withToolLog(tool_name, action, bot, metadata = {}) {
  return async function (fn) {
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
    } catch (e) {
      await logToolCall(tool_name, action, {
        bot,
        success: false,
        duration_ms: Date.now() - start,
        error: e.message,
        metadata,
      });
      throw e;
    }
  };
}

async function getRecentCalls(options = {}) {
  const conditions = [];
  const params = [];
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
    `, params);
  } catch (e) {
    return [];
  }
}

module.exports = { logToolCall, withToolLog, getRecentCalls };
