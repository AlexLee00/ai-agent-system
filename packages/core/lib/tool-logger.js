'use strict';

/**
 * packages/core/lib/tool-logger.js — 외부 도구/API 호출 로깅
 *
 * 봇이 외부 시스템(Binance, Telegram, PostgreSQL, OpenAI 등)을 호출할 때
 * 성공/실패·소요시간을 tool_calls 테이블에 기록한다.
 *
 * 사용법:
 *   const { logToolCall, withToolLog } = require('../../packages/core/lib/tool-logger');
 *
 *   // 직접 로깅
 *   const start = Date.now();
 *   try {
 *     await binance.fetchBalance();
 *     await logToolCall('binance_api', 'fetch_balance', { bot: 'hephaestos', success: true, duration_ms: Date.now() - start });
 *   } catch(e) {
 *     await logToolCall('binance_api', 'fetch_balance', { bot: 'hephaestos', success: false, duration_ms: Date.now() - start, error: e.message });
 *   }
 *
 *   // 래퍼 사용 (자동 타이밍 + 로깅)
 *   const balance = await withToolLog('binance_api', 'fetch_balance', 'hephaestos')(
 *     () => binance.fetchBalance()
 *   );
 */

const pgPool = require('./pg-pool');

let _getTraceId = () => null;
try {
  const trace = require('./trace');
  _getTraceId = trace.getTraceId;
} catch (e) {
  // trace.js 없으면 무시
}

/**
 * 외부 도구/API 호출 로깅
 * @param {string} tool_name - 도구 이름 (binance_api, telegram, postgresql, openai_embed 등)
 * @param {string} action - 수행 동작 (fetch_balance, send_message, query, create_embedding 등)
 * @param {object} [options]
 * @param {string} [options.bot] - 호출한 봇 이름
 * @param {boolean} [options.success] - 성공 여부 (기본: true)
 * @param {number} [options.duration_ms] - 소요 시간 ms
 * @param {string} [options.error] - 에러 메시지
 * @param {object} [options.metadata] - 추가 메타데이터 (금액, 심볼 등)
 */
async function logToolCall(tool_name, action, options = {}) {
  const trace_id = _getTraceId();

  try {
    await pgPool.query('reservation', `
      INSERT INTO reservation.tool_calls
        (trace_id, bot, tool_name, action, success, duration_ms, error, metadata, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    `, [
      trace_id   || null,
      options.bot       || 'unknown',
      tool_name,
      action,
      options.success !== false,
      options.duration_ms || 0,
      options.error       || null,
      JSON.stringify(options.metadata || {}),
    ]);
  } catch (e) {
    // 로깅 실패는 본 기능에 영향 없음
    console.warn('[tool-logger] 저장 실패 (무시):', e.message);
  }
}

/**
 * 타이머 래퍼 — 함수를 감싸서 자동으로 타이밍 측정 + 로깅
 * @param {string} tool_name
 * @param {string} action
 * @param {string} bot
 * @param {object} [metadata] - 추가 메타데이터
 * @returns {Function} (fn: async Function) => Promise<any>
 */
function withToolLog(tool_name, action, bot, metadata = {}) {
  return async function (fn) {
    const start = Date.now();
    try {
      const result = await fn();
      await logToolCall(tool_name, action, {
        bot,
        success:     true,
        duration_ms: Date.now() - start,
        metadata,
      });
      return result;
    } catch (e) {
      await logToolCall(tool_name, action, {
        bot,
        success:     false,
        duration_ms: Date.now() - start,
        error:       e.message,
        metadata,
      });
      throw e;
    }
  };
}

/**
 * 최근 N건 조회 (디버그용)
 * @param {object} [options]
 * @param {string} [options.bot] - 특정 봇 필터
 * @param {string} [options.tool_name] - 특정 도구 필터
 * @param {number} [options.limit]
 */
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
