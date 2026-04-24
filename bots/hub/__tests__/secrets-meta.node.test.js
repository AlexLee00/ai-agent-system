'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isSecretKey, buildFieldMeta, buildCategoryMeta } = require('../lib/secrets-meta.js');

test('isSecretKey: exact and suffix secret keys', () => {
  const positives = [
    'token', 'secret', 'password', 'pw', 'key',
    'api_key', 'access_token', 'refresh_token', 'oc',
    'bot_token', 'worker_jwt_secret', 'db_encryption_key',
    'naver_pw', 'gateway_token', 'hooks_token',
  ];
  for (const key of positives) assert.equal(isSecretKey(key), true, key);
});

test('isSecretKey: config keys are not secret', () => {
  const negatives = ['model', 'provider', 'chat_id', 'group_id', 'plan', 'ig_user_id', 'base_url', 'api_version', 'trading_mode'];
  for (const key of negatives) assert.equal(isSecretKey(key), false, key);
});

test('buildFieldMeta: scalar secret/config fields', () => {
  assert.deepEqual(buildFieldMeta('access_token', 'sk-abc'), { present: true, kind: 'secret' });
  assert.deepEqual(buildFieldMeta('api_key', ''), { present: false, kind: 'secret' });
  assert.deepEqual(buildFieldMeta('model', 'gpt-5'), { present: true, kind: 'config' });
  assert.deepEqual(buildFieldMeta('access_token', null), { present: false, kind: 'secret' });
});

test('buildFieldMeta: nested and array values', () => {
  assert.deepEqual(buildFieldMeta('accounts', [1, 2, 3]), { present: true, kind: 'array', count: 3 });
  assert.deepEqual(buildFieldMeta('topic_ids', { invest: 1, blog: 2 }), { present: true, kind: 'nested', field_count: 2 });
});

test('buildCategoryMeta: no raw secret/config value leakage', () => {
  const data = {
    access_token: 'sk-real-value',
    model: 'gpt-5-real',
    provider: 'openai-real',
  };
  const meta = buildCategoryMeta(data);
  const serialized = JSON.stringify(meta);

  assert.equal(serialized.includes('sk-real-value'), false);
  assert.equal(serialized.includes('gpt-5-real'), false);
  assert.equal(serialized.includes('openai-real'), false);
  assert.deepEqual(meta.access_token, { present: true, kind: 'secret' });
  assert.deepEqual(meta.model, { present: true, kind: 'config' });
});
