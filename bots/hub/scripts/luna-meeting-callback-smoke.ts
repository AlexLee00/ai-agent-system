#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveHubCallbackTarget } = require('../lib/telegram/callback-router.ts');
const {
  parseLunaMeetingCallbackData,
} = require('../lib/routes/luna-meeting-callback.ts');
const {
  validateLunaLiveFireCallbackEnvelope,
} = require('../lib/routes/luna-live-fire-callback.ts');

function makeReq({
  secret = 'smoke-secret',
  actorId = '123',
  username = 'master',
  chatId = '-1001',
  data = 'luna_meeting:42:confirm',
} = {}) {
  return {
    headers: {
      'x-hub-control-callback-secret': secret,
    },
    body: {
      callback_data: data,
      callback_query_id: 'fixture-callback',
      from: { id: actorId, username },
      message: { chat: { id: chatId }, message_thread_id: 44 },
    },
  };
}

async function main() {
  const target = resolveHubCallbackTarget('luna_meeting:42:confirm');
  assert.deepEqual(target, { route: '/hub/luna/meeting-callback', mode: 'luna_meeting' });
  assert.equal(resolveHubCallbackTarget('luna_meeting:42:defer')?.route, '/hub/luna/meeting-callback');
  assert.equal(resolveHubCallbackTarget('luna_meeting_bad:42:confirm'), null);

  assert.deepEqual(parseLunaMeetingCallbackData('luna_meeting:42:confirm'), {
    ok: true,
    decisionId: '42',
    action: 'confirm',
    callbackData: 'luna_meeting:42:confirm',
  });
  assert.equal(parseLunaMeetingCallbackData('luna_meeting:42:defer').action, 'defer');
  assert.equal(parseLunaMeetingCallbackData('luna_meeting:abc:confirm').error, 'invalid_luna_meeting_decision_id');
  assert.equal(parseLunaMeetingCallbackData('luna_meeting:42:delete').error, 'unsupported_luna_meeting_action');
  assert.equal(Buffer.byteLength('luna_meeting:42:confirm', 'utf8') <= 64, true);

  const env = {
    HUB_CONTROL_CALLBACK_SECRET: 'smoke-secret',
    HUB_CONTROL_APPROVER_IDS: '123',
    HUB_CONTROL_APPROVER_USERNAMES: '',
    HUB_CONTROL_APPROVAL_CHAT_ID: '-1001',
  };
  const valid = validateLunaLiveFireCallbackEnvelope(makeReq(), env);
  assert.equal(valid.ok, true);
  assert.equal(validateLunaLiveFireCallbackEnvelope(makeReq({ actorId: '999' }), env).ok, false);
  assert.equal(validateLunaLiveFireCallbackEnvelope(makeReq({ secret: 'wrong-secret' }), env).ok, false);

  console.log(JSON.stringify({
    ok: true,
    smoke: 'luna-meeting-callback',
    target,
  }, null, 2));
}

main().catch((error) => {
  console.error('[luna-meeting-callback-smoke] failed:', error?.message || error);
  process.exit(1);
});
