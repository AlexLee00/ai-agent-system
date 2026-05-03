#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveHubCallbackTarget } = require('../lib/telegram/callback-router');
const {
  buildLunaLiveFireEmergencyStopCommand,
  parseLunaLiveFireCallbackData,
  validateLunaLiveFireCallbackEnvelope,
} = require('../lib/routes/luna-live-fire-callback');

function makeReq({
  secret = 'smoke-secret',
  actorId = '123',
  username = 'master',
  chatId = '-1001',
} = {}) {
  return {
    headers: {
      'x-hub-control-callback-secret': secret,
    },
    body: {
      callback_data: 'luna_live_fire:emergency_stop',
      from: { id: actorId, username },
      message: { chat: { id: chatId }, message_thread_id: 44 },
    },
  };
}

async function main() {
  const target = resolveHubCallbackTarget('luna_live_fire:emergency_stop');
  assert.deepEqual(target, { route: '/hub/luna/live-fire/callback', mode: 'luna_live_fire' });
  assert.equal(resolveHubCallbackTarget('luna_live_fire:unknown')?.route, '/hub/luna/live-fire/callback');

  assert.deepEqual(parseLunaLiveFireCallbackData('luna_live_fire:emergency_stop'), {
    ok: true,
    action: 'emergency_stop',
  });
  assert.equal(parseLunaLiveFireCallbackData('luna_live_fire:enable').error, 'unsupported_luna_live_fire_action');

  const env = {
    HUB_CONTROL_CALLBACK_SECRET: 'smoke-secret',
    HUB_CONTROL_APPROVER_IDS: '123',
    HUB_CONTROL_APPROVER_USERNAMES: '',
    HUB_CONTROL_APPROVAL_CHAT_ID: '-1001',
  };
  const valid = validateLunaLiveFireCallbackEnvelope(makeReq(), env);
  assert.equal(valid.ok, true);

  const wrongActor = validateLunaLiveFireCallbackEnvelope(makeReq({ actorId: '999' }), env);
  assert.equal(wrongActor.ok, false);
  assert.equal(wrongActor.error, 'luna_live_fire_actor_not_allowed');

  const wrongSecret = validateLunaLiveFireCallbackEnvelope(makeReq({ secret: 'wrong-secret' }), env);
  assert.equal(wrongSecret.ok, false);
  assert.equal(wrongSecret.error, 'luna_live_fire_callback_untrusted_source');

  const command = buildLunaLiveFireEmergencyStopCommand('/repo');
  assert.equal(command.timeoutMs <= 30_000, true);
  assert.deepEqual(command.args.slice(-4), ['--apply', '--force-stop', '--confirm=rollback-luna-live-fire', '--json']);

  console.log(JSON.stringify({
    ok: true,
    smoke: 'luna-live-fire-callback',
    target,
    commandTimeoutMs: command.timeoutMs,
  }, null, 2));
}

main().catch((error) => {
  console.error('[luna-live-fire-callback-smoke] failed:', error?.message || error);
  process.exit(1);
});
