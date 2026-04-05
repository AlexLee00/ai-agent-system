'use strict';

function createSkaCommandQueue({
  pgPool,
  botId = 'ska',
  handlers = {},
  schema = 'claude',
  limit = 5,
}) {
  const WRITE_COMMANDS = new Set(['register_reservation', 'cancel_reservation']);
  const STALE_RUNNING_WRITE_MINUTES = 5;

  async function cleanupStaleRunningWrites() {
    return pgPool.run(schema, `
      UPDATE bot_commands
      SET status = 'error',
          result = $3,
          done_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
      WHERE to_bot = $1
        AND status = 'running'
        AND command = ANY($2::text[])
        AND created_at::timestamp < now() - ($4::text || ' minutes')::interval
    `, [
      botId,
      Array.from(WRITE_COMMANDS),
      JSON.stringify({
        ok: false,
        code: 'STALE_RUNNING_TIMEOUT',
        error: `running 상태가 ${STALE_RUNNING_WRITE_MINUTES}분 이상 유지되어 자동 정리됨`,
      }),
      String(STALE_RUNNING_WRITE_MINUTES),
    ]);
  }

  async function hasRunningWriteCommand() {
    const rows = await pgPool.query(schema, `
      SELECT 1
      FROM bot_commands
      WHERE to_bot = $1
        AND status = 'running'
        AND command = ANY($2::text[])
      LIMIT 1
    `, [botId, Array.from(WRITE_COMMANDS)]);
    return rows.length > 0;
  }

  async function fetchPendingCommands() {
    await cleanupStaleRunningWrites();

    const pending = await pgPool.query(schema, `
      SELECT * FROM bot_commands
      WHERE to_bot = $1 AND status = 'pending'
      ORDER BY created_at ASC
      LIMIT ${Number(limit)}
    `, [botId]);

    if (!pending.length) return pending;

    const runningWrite = await hasRunningWriteCommand();
    const firstWrite = pending.find((row) => WRITE_COMMANDS.has(row.command));

    if (runningWrite) {
      return pending.filter((row) => !WRITE_COMMANDS.has(row.command));
    }

    if (firstWrite) {
      return [firstWrite];
    }

    return pending;
  }

  async function markRunning(id) {
    await pgPool.run(schema, `
      UPDATE bot_commands SET status = 'running' WHERE id = $1
    `, [id]);
  }

  async function markCompleted(id, result) {
    await pgPool.run(schema, `
      UPDATE bot_commands
      SET status = $1, result = $2, done_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
      WHERE id = $3
    `, [result.ok ? 'done' : 'error', JSON.stringify(result), id]);
  }

  async function enqueueRetry(commandRow, args, result) {
    const retryCount = Number(args.retry_count || 0);
    const maxRetries = Number(args.max_retries || (args.batch_request ? 1 : 0));
    if (retryCount >= maxRetries) return false;
    if (!WRITE_COMMANDS.has(commandRow.command)) return false;
    if (!args.batch_request) return false;

    const retryArgs = {
      ...args,
      manual_retry: true,
      retry_count: retryCount + 1,
      retry_of: commandRow.id,
      last_error: result?.error || result?.message || result?.code || 'retry_requested',
    };

    await pgPool.run(schema, `
      INSERT INTO bot_commands (to_bot, command, args)
      VALUES ($1, $2, $3)
    `, [commandRow.to_bot, commandRow.command, JSON.stringify(retryArgs)]);
    return true;
  }

  async function executeCommand(commandRow) {
    await markRunning(commandRow.id);

    let args = {};
    let result;
    try {
      args = JSON.parse(commandRow.args || '{}');
      const handler = handlers[commandRow.command];

      if (!handler) {
        result = { ok: false, error: `알 수 없는 명령: ${commandRow.command}` };
      } else {
        result = await Promise.resolve(handler(args, commandRow));
      }
    } catch (e) {
      result = { ok: false, error: e.message };
    }

    const retryQueued = await enqueueRetry(commandRow, args, result);
    if (retryQueued) {
      result = {
        ...result,
        retryQueued: true,
        retryCount: Number(args.retry_count || 0) + 1,
      };
    }

    await markCompleted(commandRow.id, result);
    return result;
  }

  async function processPendingCommands() {
    const pending = await fetchPendingCommands();
    const results = [];

    for (const commandRow of pending) {
      const result = await executeCommand(commandRow);
      results.push({
        id: commandRow.id,
        command: commandRow.command,
        ok: !!result.ok,
      });
    }

    return results;
  }

  return {
    fetchPendingCommands,
    executeCommand,
    processPendingCommands,
  };
}

module.exports = {
  createSkaCommandQueue,
};
