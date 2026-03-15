'use strict';

function createSkaCommandQueue({
  pgPool,
  botId = 'ska',
  handlers = {},
  schema = 'claude',
  limit = 5,
}) {
  async function fetchPendingCommands() {
    return pgPool.query(schema, `
      SELECT * FROM bot_commands
      WHERE to_bot = $1 AND status = 'pending'
      ORDER BY created_at ASC
      LIMIT ${Number(limit)}
    `, [botId]);
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

  async function executeCommand(commandRow) {
    await markRunning(commandRow.id);

    let result;
    try {
      const args = JSON.parse(commandRow.args || '{}');
      const handler = handlers[commandRow.command];

      if (!handler) {
        result = { ok: false, error: `알 수 없는 명령: ${commandRow.command}` };
      } else {
        result = await Promise.resolve(handler(args, commandRow));
      }
    } catch (e) {
      result = { ok: false, error: e.message };
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
