// @ts-nocheck
'use strict';

const assert = require('node:assert');
const {
  isAuthorizedMasterSender,
} = require('../lib/routes/jaenong-command.ts');

const previousChatIds = process.env.MASTER_TELEGRAM_CHAT_IDS;
const previousUserIds = process.env.MASTER_TELEGRAM_USER_IDS;

try {
  process.env.MASTER_TELEGRAM_CHAT_IDS = '123,-100200';
  process.env.MASTER_TELEGRAM_USER_IDS = '999';

  assert.equal(isAuthorizedMasterSender('123', '123', 'private'), true);
  assert.equal(isAuthorizedMasterSender('123', '456', 'private'), false);
  assert.equal(isAuthorizedMasterSender('-100200', '999', 'supergroup'), true);
  assert.equal(isAuthorizedMasterSender('-100200', '123', 'supergroup'), true);
  assert.equal(isAuthorizedMasterSender('-100200', '456', 'supergroup'), false);
  assert.equal(isAuthorizedMasterSender('-100200', '', 'supergroup'), false);
  assert.equal(isAuthorizedMasterSender('-100999', '999', 'supergroup'), false);

  delete process.env.MASTER_TELEGRAM_USER_IDS;
  assert.equal(isAuthorizedMasterSender('-100200', '123', 'supergroup'), true);
  assert.equal(isAuthorizedMasterSender('-100200', '456', 'supergroup'), false);

  process.env.MASTER_TELEGRAM_USER_IDS = '';
  assert.equal(isAuthorizedMasterSender('-100200', '123', 'supergroup'), true);
  assert.equal(isAuthorizedMasterSender('-100200', '456', 'supergroup'), false);

  process.env.MASTER_TELEGRAM_USER_IDS = '999';
  assert.equal(isAuthorizedMasterSender('-100200', '123', ''), false);
  assert.equal(isAuthorizedMasterSender('-100200', '123', 'channel'), false);

  console.log('✅ jaenong command auth smoke ok');
} finally {
  if (previousChatIds === undefined) delete process.env.MASTER_TELEGRAM_CHAT_IDS;
  else process.env.MASTER_TELEGRAM_CHAT_IDS = previousChatIds;
  if (previousUserIds === undefined) delete process.env.MASTER_TELEGRAM_USER_IDS;
  else process.env.MASTER_TELEGRAM_USER_IDS = previousUserIds;
}
