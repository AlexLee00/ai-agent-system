'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isSecretKey, buildFieldMeta, buildCategoryMeta, buildRequiredSummary } = require('../lib/secrets-meta.js');

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

test('buildFieldMeta: array values', () => {
  const r = buildFieldMeta('accounts', [1, 2, 3]);
  assert.equal(r.kind, 'array');
  assert.equal(r.count, 3);
  assert.equal(r.present, true);
  // 원시값 배열은 element_keys 없음
  assert.equal('element_keys' in r, false);
});

test('buildFieldMeta: array of objects shows element_keys not values', () => {
  const r = buildFieldMeta('accounts', [{ user_id: 'real-uid', secret: 'real-secret' }]);
  assert.equal(r.kind, 'array');
  assert.equal(r.count, 1);
  assert.deepEqual(r.element_keys, ['user_id', 'secret']);
  // 실제 값 미노출
  const s = JSON.stringify(r);
  assert.equal(s.includes('real-uid'), false);
  assert.equal(s.includes('real-secret'), false);
});

test('buildFieldMeta: nested object is recursive', () => {
  const r = buildFieldMeta('korea_law', {
    user_id: 'real-uid',
    user_name: 'real-name',
    oc: 'real-oc',
    base_url: 'https://example.com',
  });
  assert.equal(r.kind, 'nested');
  assert.equal(r.field_count, 4);
  assert.equal(typeof r.fields, 'object');
  // 하위 field presence 표시
  assert.equal(r.fields.user_id.present, true);
  assert.equal(r.fields.user_id.kind, 'config');
  assert.equal(r.fields.oc.present, true);
  assert.equal(r.fields.oc.kind, 'secret');
  assert.equal(r.fields.user_name.present, true);
  assert.equal(r.fields.base_url.kind, 'config');
});

test('buildFieldMeta: nested scalar values not leaked', () => {
  const r = buildFieldMeta('korea_law', {
    user_id: 'real-uid',
    oc: 'real-oc-value',
  });
  const s = JSON.stringify(r);
  assert.equal(s.includes('real-uid'), false);
  assert.equal(s.includes('real-oc-value'), false);
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

test('buildCategoryMeta: nested secret values not leaked', () => {
  const data = {
    korea_law: {
      user_id: 'real-uid',
      user_name: 'real-name',
      oc: 'real-oc-value',
    },
  };
  const meta = buildCategoryMeta(data);
  const s = JSON.stringify(meta);
  assert.equal(s.includes('real-uid'), false);
  assert.equal(s.includes('real-name'), false);
  assert.equal(s.includes('real-oc-value'), false);
  // 하위 field presence는 표시됨
  assert.equal(meta.korea_law.fields.oc.present, true);
  assert.equal(meta.korea_law.fields.oc.kind, 'secret');
});

test('buildRequiredSummary: justin all present', () => {
  const data = {
    korea_law: { user_id: 'uid', user_name: 'name', oc: 'oc-val', base_url: 'http://x' },
  };
  const r = buildRequiredSummary('justin', data);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.present, ['korea_law.user_id', 'korea_law.user_name', 'korea_law.oc']);
});

test('buildRequiredSummary: justin missing oc', () => {
  const data = {
    korea_law: { user_id: 'uid', user_name: 'name', oc: '', base_url: 'http://x' },
  };
  const r = buildRequiredSummary('justin', data);
  assert.deepEqual(r.missing, ['korea_law.oc']);
  assert.deepEqual(r.present, ['korea_law.user_id', 'korea_law.user_name']);
});

test('buildRequiredSummary: justin missing korea_law entirely', () => {
  const data = {};
  const r = buildRequiredSummary('justin', data);
  assert.deepEqual(r.missing, ['korea_law.user_id', 'korea_law.user_name', 'korea_law.oc']);
  assert.deepEqual(r.present, []);
});

test('buildRequiredSummary: openai_oauth present', () => {
  const r = buildRequiredSummary('openai_oauth', { access_token: 'tok' });
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.present, ['access_token']);
});

test('buildRequiredSummary: telegram missing bot_token', () => {
  const r = buildRequiredSummary('telegram', {});
  assert.deepEqual(r.missing, ['bot_token']);
});

test('buildRequiredSummary: no required map returns null', () => {
  const r = buildRequiredSummary('unknown_category', { foo: 'bar' });
  assert.equal(r, null);
});

test('buildRequiredSummary: required summary values not leaked', () => {
  const data = {
    korea_law: { user_id: 'real-uid', user_name: 'real-name', oc: 'real-oc' },
  };
  const r = buildRequiredSummary('justin', data);
  const s = JSON.stringify(r);
  assert.equal(s.includes('real-uid'), false);
  assert.equal(s.includes('real-name'), false);
  assert.equal(s.includes('real-oc'), false);
});
