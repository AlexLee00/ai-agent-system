'use strict';

// Secret Metadata 헬퍼 단위 테스트
// 값 노출 없이 presence/kind만 반환하는지 검증

const { isSecretKey, buildFieldMeta, buildCategoryMeta } = require('../lib/secrets-meta');

// ─── isSecretKey ─────────────────────────────────────────────────────────────

describe('isSecretKey', () => {
  test.each([
    ['token', true],
    ['secret', true],
    ['password', true],
    ['pw', true],
    ['key', true],
    ['api_key', true],
    ['access_token', true],
    ['refresh_token', true],
    ['oc', true],
    ['bot_token', true],
    ['worker_jwt_secret', true],
    ['db_encryption_key', true],
    ['naver_pw', true],
    ['gateway_token', true],
    ['hooks_token', true],
  ])('%s → true', (k, expected) => {
    expect(isSecretKey(k)).toBe(expected);
  });

  test.each([
    ['model', false],
    ['provider', false],
    ['chat_id', false],
    ['group_id', false],
    ['plan', false],
    ['ig_user_id', false],
    ['base_url', false],
    ['api_version', false],
    ['trading_mode', false],
  ])('%s → false', (k, expected) => {
    expect(isSecretKey(k)).toBe(expected);
  });
});

// ─── buildFieldMeta ───────────────────────────────────────────────────────────

describe('buildFieldMeta', () => {
  it('secret key with value → present:true, kind:secret', () => {
    expect(buildFieldMeta('access_token', 'sk-abc')).toEqual({ present: true, kind: 'secret' });
  });

  it('secret key with empty string → present:false, kind:secret', () => {
    expect(buildFieldMeta('api_key', '')).toEqual({ present: false, kind: 'secret' });
  });

  it('config key with value → present:true, kind:config', () => {
    expect(buildFieldMeta('model', 'gpt-5')).toEqual({ present: true, kind: 'config' });
  });

  it('array value → kind:array with count', () => {
    const result = buildFieldMeta('accounts', [1, 2, 3]);
    expect(result.kind).toBe('array');
    expect(result.count).toBe(3);
    expect(result.present).toBe(true);
  });

  it('nested object → kind:nested with field_count', () => {
    const result = buildFieldMeta('topic_ids', { invest: 1, blog: 2 });
    expect(result.kind).toBe('nested');
    expect(result.field_count).toBe(2);
    expect(result.present).toBe(true);
  });

  it('null secret key → present:false', () => {
    expect(buildFieldMeta('access_token', null)).toEqual({ present: false, kind: 'secret' });
  });
});

// ─── 값 노출 방지 검증 ──────────────────────────────────────────────────────

describe('buildCategoryMeta: 값 노출 방지', () => {
  const data = {
    access_token: 'sk-real-value',
    model: 'gpt-5-real',
    provider: 'openai-real',
  };

  it('결과에 실제 값이 포함되지 않는다', () => {
    const meta = buildCategoryMeta(data);
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain('sk-real-value');
    expect(serialized).not.toContain('gpt-5-real');
    expect(serialized).not.toContain('openai-real');
  });

  it('access_token은 present:true, kind:secret으로만 표시', () => {
    const meta = buildCategoryMeta(data);
    expect(meta.access_token).toEqual({ present: true, kind: 'secret' });
  });

  it('model은 present:true, kind:config으로 표시', () => {
    const meta = buildCategoryMeta(data);
    expect(meta.model).toEqual({ present: true, kind: 'config' });
  });
});
