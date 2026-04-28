#!/usr/bin/env tsx
import assert from 'node:assert/strict';

async function main() {
  const originalBotQueue = process.env.JAY_COMMANDER_BOT_QUEUE_ENABLED;
  const originalAllowVirtual = process.env.JAY_COMMANDER_ALLOW_VIRTUAL;
  process.env.JAY_COMMANDER_BOT_QUEUE_ENABLED = 'false';
  delete process.env.JAY_COMMANDER_ALLOW_VIRTUAL;

  try {
    const dispatcher = require('../lib/control/commander-dispatcher.ts');
    await dispatcher.ensureCommanderDispatchTables();

    const incidentKey = `dispatch-smoke:${Date.now()}`;
    const queued = await dispatcher.queueCommanderTask({
      incidentKey,
      team: 'luna',
      stepId: 'verify_position',
      payload: {
        goal: 'dispatch smoke',
        objective: 'dispatch smoke objective',
      },
    });
    assert.equal(queued?.ok, true, 'queueCommanderTask should succeed');

    const blocked = await dispatcher.dispatchCommanderTask(queued.task, {
      timeoutMs: 20_000,
      maxRetry: 1,
    });
    assert.equal(blocked?.ok, false, 'virtual adapter should be blocked by default');
    assert.match(String(blocked?.error || ''), /commander_adapter_virtual_disabled/, 'virtual block reason expected');

    process.env.JAY_COMMANDER_ALLOW_VIRTUAL = 'true';
    const queuedAllowed = await dispatcher.queueCommanderTask({
      incidentKey: `${incidentKey}:allowed`,
      team: 'luna',
      stepId: 'verify_position',
      payload: {
        goal: 'dispatch smoke',
        objective: 'dispatch smoke objective',
      },
    });
    assert.equal(queuedAllowed?.ok, true, 'queueCommanderTask should succeed for allow path');

    const result = await dispatcher.dispatchCommanderTask(queuedAllowed.task, {
      timeoutMs: 20_000,
      maxRetry: 1,
    });
    assert.equal(result?.ok, true, 'dispatchCommanderTask should succeed when virtual is explicitly allowed');
    assert.equal(result?.final?.status, 'completed', 'virtual adapter should close as completed');

    const stats = await dispatcher.getCommanderDispatchStats();
    assert.equal(stats?.ok, true, 'dispatch stats should load');
    console.log('jay_to_commander_dispatch_smoke_ok');
  } finally {
    if (originalBotQueue == null) delete process.env.JAY_COMMANDER_BOT_QUEUE_ENABLED;
    else process.env.JAY_COMMANDER_BOT_QUEUE_ENABLED = originalBotQueue;
    if (originalAllowVirtual == null) delete process.env.JAY_COMMANDER_ALLOW_VIRTUAL;
    else process.env.JAY_COMMANDER_ALLOW_VIRTUAL = originalAllowVirtual;
  }
}

main().catch((error) => {
  console.error(`jay_to_commander_dispatch_smoke_failed: ${error?.message || error}`);
  process.exit(1);
});
