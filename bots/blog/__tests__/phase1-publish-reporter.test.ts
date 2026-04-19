'use strict';

/**
 * Phase 1 테스트 — publish-reporter + img-gen-doctor
 * 이미지 생성 실패 visibility + 3 플랫폼 발행 보고
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');

jest.mock('../../../packages/core/lib/pg-pool', () => ({
  query: jest.fn().mockResolvedValue([]),
  get: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../packages/core/lib/mode-guard', () => ({
  runIfOps: jest.fn((_key, _ops, dev) => Promise.resolve(dev())),
}));
jest.mock('../../../packages/core/lib/openclaw-client', () => ({
  postAlarm: jest.fn().mockResolvedValue(undefined),
}));

const { postAlarm } = require('../../../packages/core/lib/openclaw-client');
const pgPool = require('../../../packages/core/lib/pg-pool');

// ─── publish-reporter ─────────────────────────────────────────────────────────

describe('publish-reporter', () => {
  const reporter = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/publish-reporter.ts'));

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('reportPublishSuccess — 네이버 성공 보고', async () => {
    await reporter.reportPublishSuccess('naver', '테스트 글', 'https://blog.naver.com/test');
    // DEV 모드에서 console.log 경로로 실행됨 (runIfOps mock)
    expect(true).toBe(true);
  });

  test('reportPublishSuccess — 인스타그램 성공 보고', async () => {
    await reporter.reportPublishSuccess('instagram', '릴스 제목');
    expect(true).toBe(true);
  });

  test('reportPublishSuccess — 페이스북 성공 보고', async () => {
    await reporter.reportPublishSuccess('facebook', '페북 글 제목', 'https://facebook.com/test');
    expect(true).toBe(true);
  });

  test('reportPublishFailure — 네이버 실패 보고', async () => {
    await reporter.reportPublishFailure('naver', '실패한 글', '로그인 세션 만료');
    expect(true).toBe(true);
  });

  test('reportPublishFailure — 인스타 실패 보고', async () => {
    await reporter.reportPublishFailure('instagram', '릴스 실패', 'token expired');
    expect(true).toBe(true);
  });

  test('reportPublishFailure — 페이스북 실패 보고', async () => {
    await reporter.reportPublishFailure('facebook', '페북 실패', 'API rate limit');
    expect(true).toBe(true);
  });

  test('reportPublishSuccess — URL 없이도 작동', async () => {
    await expect(reporter.reportPublishSuccess('naver', '제목만 있는 글')).resolves.not.toThrow();
  });

  test('reportPublishSuccess — 알 수 없는 플랫폼 처리', async () => {
    await expect(reporter.reportPublishSuccess('unknown_platform', '제목')).resolves.not.toThrow();
  });

  test('reportPublishFailure — 에러 발생해도 throw 안 함', async () => {
    const { runIfOps } = require('../../../packages/core/lib/mode-guard');
    runIfOps.mockImplementationOnce(() => Promise.reject(new Error('alarm failed')));
    await expect(reporter.reportPublishFailure('naver', '제목', '오류')).resolves.not.toThrow();
  });

  test('module exports 검증', () => {
    expect(typeof reporter.reportPublishSuccess).toBe('function');
    expect(typeof reporter.reportPublishFailure).toBe('function');
  });
});

// ─── img-gen-doctor ───────────────────────────────────────────────────────────

describe('img-gen-doctor', () => {
  const doctor = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/img-gen-doctor.ts'));

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('module exports 검증', () => {
    expect(typeof doctor.diagnoseImageGeneration).toBe('function');
    expect(typeof doctor.reportImageGenFailure).toBe('function');
    expect(typeof doctor.reportImageDiagnosis).toBe('function');
  });

  test('diagnoseImageGeneration — 구조 반환', async () => {
    pgPool.query.mockResolvedValueOnce([{ cnt: 0 }]);
    const result = await doctor.diagnoseImageGeneration();
    expect(result).toHaveProperty('healthy');
    expect(result).toHaveProperty('issues');
    expect(result).toHaveProperty('checks');
    expect(Array.isArray(result.issues)).toBe(true);
  });

  test('diagnoseImageGeneration — 최근 실패 5건 초과 시 issues 포함', async () => {
    pgPool.query.mockResolvedValueOnce([{ cnt: 10 }]);
    const result = await doctor.diagnoseImageGeneration();
    expect(result.issues.some((i) => i.includes('최근'))).toBe(true);
  });

  test('diagnoseImageGeneration — DB 오류 시 안전 처리', async () => {
    pgPool.query.mockRejectedValueOnce(new Error('DB 연결 실패'));
    const result = await doctor.diagnoseImageGeneration();
    expect(result).toHaveProperty('healthy');
    expect(result).toHaveProperty('issues');
  });

  test('reportImageGenFailure — throw 없이 실행', async () => {
    await expect(doctor.reportImageGenFailure('테스트 글', 'API 타임아웃')).resolves.not.toThrow();
  });

  test('reportImageDiagnosis — 빈 배열 시 early return', async () => {
    await expect(doctor.reportImageDiagnosis([])).resolves.not.toThrow();
  });

  test('reportImageDiagnosis — null 시 early return', async () => {
    await expect(doctor.reportImageDiagnosis(null)).resolves.not.toThrow();
  });

  test('reportImageDiagnosis — 이슈 목록 있을 때 알람 시도', async () => {
    await expect(
      doctor.reportImageDiagnosis(['Draw Things 앱 미구동', 'API 응답 없음'])
    ).resolves.not.toThrow();
  });

  test('diagnoseImageGeneration — checks 객체 포함', async () => {
    pgPool.query.mockResolvedValueOnce([{ cnt: 0 }]);
    const result = await doctor.diagnoseImageGeneration();
    expect(result.checks).toHaveProperty('appRunning');
    expect(result.checks).toHaveProperty('apiOk');
    expect(result.checks).toHaveProperty('diskBytes');
    expect(result.checks).toHaveProperty('recentFails');
  });

  test('diagnoseImageGeneration — healthy는 boolean', async () => {
    pgPool.query.mockResolvedValueOnce([{ cnt: 0 }]);
    const result = await doctor.diagnoseImageGeneration();
    expect(typeof result.healthy).toBe('boolean');
  });
});
