'use strict';

const pgPool = require('../../../../packages/core/lib/pg-pool');
const { createVirtualCommanderAdapter } = require('../../../../packages/core/lib/commander-contract.ts');

function normalizeText(value, fallback = '') {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

async function insertBotCommand(toBot, command, args = {}) {
  const row = await pgPool.get('claude', `
    INSERT INTO bot_commands (to_bot, command, args)
    VALUES ($1, $2, $3::jsonb)
    RETURNING id
  `, [toBot, command, JSON.stringify(args || {})]);
  return Number(row?.id || 0) || null;
}

async function waitForBotCommandResult(id, timeoutMs = 120_000) {
  const deadline = Date.now() + Math.max(2000, Number(timeoutMs || 120_000) || 120_000);
  while (Date.now() < deadline) {
    const row = await pgPool.get('claude', `
      SELECT status, result
      FROM bot_commands
      WHERE id = $1
    `, [id]);
    if (row && row.status !== 'pending') {
      return {
        status: normalizeText(row.status, 'unknown'),
        result: row.result,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return null;
}

function createBotCommandAdapter(team, options = {}) {
  const normalizedTeam = normalizeText(team, 'general').toLowerCase();
  const toBot = normalizeText(options.toBot, '');
  const base = createVirtualCommanderAdapter(normalizedTeam, { label: `${normalizedTeam}-adapter` });

  if (!toBot) {
    return {
      ...base,
      mode: 'virtual',
    };
  }

  return {
    ...base,
    mode: 'bot_command',
    async acceptIncidentTask(task) {
      const accepted = await base.acceptIncidentTask(task);
      if (!accepted.ok) return accepted;
      const cmdId = await insertBotCommand(toBot, 'incident_task', {
        incidentKey: task.incidentKey,
        stepId: task.stepId,
        goal: task.goal,
        payload: task.payload || {},
        planStep: task.planStep || {},
        deadlineAt: task.deadlineAt || null,
      });
      if (!cmdId) {
        return { ok: false, error: 'bot_command_insert_failed' };
      }
      return {
        ok: true,
        status: 'queued',
        incidentKey: task.incidentKey,
        stepId: task.stepId,
        team: normalizedTeam,
        commandId: cmdId,
        acceptedAt: new Date().toISOString(),
      };
    },
    async finalSummary(summaryInput) {
      const commandId = Number(summaryInput?.commandId || 0) || null;
      if (!commandId) return base.finalSummary(summaryInput);
      const waited = await waitForBotCommandResult(commandId, Number(options.timeoutMs || 120_000));
      if (!waited) {
        return {
          ok: false,
          status: 'failed',
          incidentKey: summaryInput?.incidentKey || null,
          team: normalizedTeam,
          error: 'bot_command_timeout',
          commandId,
        };
      }
      return {
        ok: true,
        status: waited.status === 'done' ? 'completed' : waited.status,
        incidentKey: summaryInput?.incidentKey || null,
        team: normalizedTeam,
        result: waited.result || null,
        evidence: {
          commandId,
          botStatus: waited.status,
        },
      };
    },
  };
}

module.exports = {
  createBotCommandAdapter,
  waitForBotCommandResult,
  insertBotCommand,
};
