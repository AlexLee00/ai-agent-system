#!/usr/bin/env tsx
import assert from 'node:assert/strict';

async function main() {
  const originalBotQueue = process.env.JAY_COMMANDER_BOT_QUEUE_ENABLED;
  const originalAllowVirtual = process.env.JAY_COMMANDER_ALLOW_VIRTUAL;
  process.env.JAY_COMMANDER_BOT_QUEUE_ENABLED = 'true';
  delete process.env.JAY_COMMANDER_ALLOW_VIRTUAL;

  try {
    const commanderRegistry = require('../../orchestrator/lib/commanders/index.ts');
    const pgPool = require('../../../packages/core/lib/pg-pool');
    for (const team of ['luna', 'blog', 'ska']) {
      const adapter = commanderRegistry.getCommanderAdapter(team);
      assert.equal(adapter?.mode, 'bot_command', `${team} adapter should use bot_command mode`);
      const incidentKey = `bot-command-smoke:${team}:${Date.now()}`;
      const accepted = await adapter.acceptIncidentTask({
        incidentKey,
        team,
        stepId: 'bot_command_smoke',
        goal: `${team} bot command smoke`,
        payload: { smoke: true },
        planStep: { id: 'bot_command_smoke', sideEffect: 'write' },
      });
      assert.equal(accepted?.ok, true, `${team} adapter should accept task`);
      assert.ok(Number(accepted?.commandId || 0) > 0, `${team} command id should be created`);
      await pgPool.run('claude', `
        UPDATE bot_commands
        SET status = 'done',
            result = $2::jsonb,
            done_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
        WHERE id = $1
      `, [
        Number(accepted.commandId),
        JSON.stringify({ ok: true, team, smoke: true }),
      ]);
      const final = await adapter.finalSummary({
        incidentKey,
        team,
        stepId: 'bot_command_smoke',
        commandId: accepted.commandId,
      });
      assert.equal(final?.ok, true, `${team} final summary should succeed`);
      assert.equal(final?.status, 'completed', `${team} final status should normalize to completed`);
    }
    console.log('jay_commander_bot_command_smoke_ok');
  } finally {
    if (originalBotQueue == null) delete process.env.JAY_COMMANDER_BOT_QUEUE_ENABLED;
    else process.env.JAY_COMMANDER_BOT_QUEUE_ENABLED = originalBotQueue;
    if (originalAllowVirtual == null) delete process.env.JAY_COMMANDER_ALLOW_VIRTUAL;
    else process.env.JAY_COMMANDER_ALLOW_VIRTUAL = originalAllowVirtual;
  }
}

main().catch((error) => {
  console.error(`jay_commander_bot_command_smoke_failed: ${error?.message || error}`);
  process.exit(1);
});
