'use strict';

// Secret Metadata 헬퍼 단위 테스트
// 값 노출 없이 presence/kind만 반환하는지 검증

const { isSecretKey, buildFieldMeta, buildCategoryMeta, buildRequiredSummary } = require('../lib/secrets-meta');

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

  it('array of primitives → kind:array with count, no element_keys', () => {
    const result = buildFieldMeta('accounts', [1, 2, 3]);
    expect(result.kind).toBe('array');
    expect(result.count).toBe(3);
    expect(result.present).toBe(true);
    expect('element_keys' in result).toBe(false);
  });

  it('array of objects → element_keys shown, values not leaked', () => {
    const result = buildFieldMeta('accounts', [{ user_id: 'real', secret: 'val' }]);
    expect(result.kind).toBe('array');
    expect(result.count).toBe(1);
    expect(result.element_keys).toEqual(['user_id', 'secret']);
    expect(JSON.stringify(result)).not.toContain('real');
    expect(JSON.stringify(result)).not.toContain('val');
  });

  it('nested object → kind:nested with field_count and recursive fields', () => {
    const result = buildFieldMeta('topic_ids', { invest: 1, blog: 2 });
    expect(result.kind).toBe('nested');
    expect(result.field_count).toBe(2);
    expect(result.present).toBe(true);
    expect(typeof result.fields).toBe('object');
  });

  it('nested object oc field → kind:secret', () => {
    const result = buildFieldMeta('korea_law', {
      user_id: 'uid', user_name: 'name', oc: 'oc-val', base_url: 'http://x',
    });
    expect(result.fields.oc.kind).toBe('secret');
    expect(result.fields.oc.present).toBe(true);
    expect(result.fields.user_id.kind).toBe('config');
  });

  it('nested scalar values not leaked at any depth', () => {
    const result = buildFieldMeta('korea_law', { user_id: 'real-uid', oc: 'real-oc' });
    const s = JSON.stringify(result);
    expect(s).not.toContain('real-uid');
    expect(s).not.toContain('real-oc');
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

describe('buildCategoryMeta: nested 값 노출 방지', () => {
  it('nested secret 값이 어떤 깊이에서도 노출되지 않는다', () => {
    const data = {
      korea_law: { user_id: 'real-uid', user_name: 'real-name', oc: 'real-oc' },
    };
    const meta = buildCategoryMeta(data);
    const s = JSON.stringify(meta);
    expect(s).not.toContain('real-uid');
    expect(s).not.toContain('real-name');
    expect(s).not.toContain('real-oc');
    expect(meta.korea_law.fields.oc.kind).toBe('secret');
    expect(meta.korea_law.fields.oc.present).toBe(true);
  });
});

// ─── buildRequiredSummary ────────────────────────────────────────────────────

describe('buildRequiredSummary', () => {
  it('justin: all required fields present', () => {
    const data = {
      korea_law: { user_id: 'uid', user_name: 'name', oc: 'oc-val', base_url: 'http://x' },
    };
    const r = buildRequiredSummary('justin', data);
    expect(r.missing).toEqual([]);
    expect(r.present).toEqual(['korea_law.user_id', 'korea_law.user_name', 'korea_law.oc']);
  });

  it('justin: oc missing', () => {
    const data = { korea_law: { user_id: 'uid', user_name: 'name', oc: '' } };
    const r = buildRequiredSummary('justin', data);
    expect(r.missing).toEqual(['korea_law.oc']);
    expect(r.present).toEqual(['korea_law.user_id', 'korea_law.user_name']);
  });

  it('justin: korea_law entirely absent', () => {
    const r = buildRequiredSummary('justin', {});
    expect(r.missing).toEqual(['korea_law.user_id', 'korea_law.user_name', 'korea_law.oc']);
    expect(r.present).toEqual([]);
  });

  it('openai_oauth: access_token present', () => {
    const r = buildRequiredSummary('openai_oauth', { access_token: 'tok' });
    expect(r.missing).toEqual([]);
    expect(r.present).toEqual(['access_token']);
  });

  it('telegram: bot_token missing', () => {
    const r = buildRequiredSummary('telegram', {});
    expect(r.missing).toEqual(['bot_token']);
  });

  it('unknown category returns null', () => {
    expect(buildRequiredSummary('unknown_category', { foo: 'bar' })).toBeNull();
  });

  it('required summary contains only paths, no actual values', () => {
    const data = {
      korea_law: { user_id: 'real-uid', user_name: 'real-name', oc: 'real-oc' },
    };
    const r = buildRequiredSummary('justin', data);
    const s = JSON.stringify(r);
    expect(s).not.toContain('real-uid');
    expect(s).not.toContain('real-name');
    expect(s).not.toContain('real-oc');
  });
});
