'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');

describe('curriculum transition', () => {
  let pgPool;
  let planner;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../../../packages/core/lib/hub-alarm-client', () => ({
      postAlarm: jest.fn().mockResolvedValue({ ok: true }),
    }));
    jest.doMock('../../../packages/core/lib/mode-guard', () => ({
      runIfOps: jest.fn(async (_label, _ops, dev) => (typeof dev === 'function' ? dev() : undefined)),
    }));
    jest.doMock('../../../packages/core/lib/agent-memory', () => ({
      createAgentMemory: jest.fn(() => ({
        recallCountHint: jest.fn().mockResolvedValue(''),
        recallHint: jest.fn().mockResolvedValue(''),
        remember: jest.fn().mockResolvedValue(null),
        consolidate: jest.fn().mockResolvedValue(null),
      })),
    }));

    pgPool = require('../../../packages/core/lib/pg-pool');
    pgPool.query = jest.fn();
    pgPool.run = jest.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    planner = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/curriculum-planner.ts'));
  });

  test('planned 시리즈가 없으면 active 완료 처리와 회전 리셋을 하지 않는다', async () => {
    pgPool.query.mockResolvedValueOnce([]);

    const result = await planner.transitionSeries();

    expect(result).toBeNull();
    expect(pgPool.query).toHaveBeenCalledTimes(1);
    expect(pgPool.run).not.toHaveBeenCalled();
  });

  test('planned 시리즈를 active로 전환하고 lecture rotation을 0으로 리셋한다', async () => {
    pgPool.query.mockResolvedValueOnce([
      { id: 2, series_name: 'Python', total_lectures: 120, status: 'active' },
    ]);

    const result = await planner.transitionSeries();

    expect(result.series_name).toBe('Python');
    expect(pgPool.run).toHaveBeenCalledWith(
      'blog',
      expect.stringContaining('UPDATE blog.category_rotation'),
      ['Python'],
    );
  });
});

describe('lecture schedule transition guard', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('완료된 시리즈 전환 실패 시 121강 스케줄을 만들지 않는다', async () => {
    jest.doMock('../../../packages/core/lib/env', () => ({
      PROJECT_ROOT: path.resolve(__dirname, '../../..'),
      IS_DEV: false,
    }));
    jest.doMock('../../../packages/core/lib/kst', () => ({
      today: jest.fn(() => '2026-06-09'),
    }));
    jest.doMock('../../../packages/core/lib/pg-pool', () => ({
      query: jest.fn(),
      get: jest.fn(),
      run: jest.fn(),
    }));
    jest.doMock('../../../packages/core/lib/hub-alarm-client', () => ({
      postAlarm: jest.fn().mockResolvedValue({ ok: true }),
    }));
    jest.doMock('../../../packages/core/lib/mode-guard', () => ({
      runIfOps: jest.fn(async (_label, _ops, dev) => (typeof dev === 'function' ? dev() : undefined)),
    }));
    jest.doMock('../../../packages/core/lib/agent-memory', () => ({
      createAgentMemory: jest.fn(() => ({
        recallCountHint: jest.fn().mockResolvedValue(''),
        recallHint: jest.fn().mockResolvedValue(''),
        remember: jest.fn().mockResolvedValue(null),
        consolidate: jest.fn().mockResolvedValue(null),
      })),
    }));
    jest.doMock('../../../packages/core/lib/hub-client', () => ({
      callHubLlm: jest.fn().mockResolvedValue({ text: '' }),
    }));
    jest.doMock('../lib/schema.ts', () => ({
      ensureBlogCoreSchema: jest.fn().mockResolvedValue(null),
    }));
    jest.doMock('../lib/category-rotation.ts', () => ({
      getNextLectureNumber: jest.fn().mockResolvedValue({ number: 121, seriesName: 'nodejs_120' }),
      getLectureTitle: jest.fn().mockResolvedValue(null),
      getNextGeneralCategory: jest.fn().mockResolvedValue({ category: '최신IT트렌드' }),
    }));

    const mockedPgPool = require('../../../packages/core/lib/pg-pool');
    mockedPgPool.query.mockImplementation(async (_schema, sql) => {
      const text = String(sql);
      if (text.includes("WHERE status = 'active'")) {
        return [{ series_name: 'nodejs_120', total_lectures: 120, status: 'active' }];
      }
      if (text.includes('SELECT current_index FROM blog.category_rotation')) {
        return [{ current_index: 120 }];
      }
      if (text.includes("status IN ('planned', 'candidate')")) {
        return [{ id: 2 }];
      }
      if (text.includes("WHERE status = 'planned'")) return [];
      if (text.includes("WHERE status = 'candidate'")) return [];
      return [];
    });
    mockedPgPool.get.mockResolvedValue(null);
    mockedPgPool.run.mockResolvedValue({ rowCount: 0, rows: [] });

    const { ensureSchedule } = require('../lib/schedule.ts');
    const rows = await ensureSchedule('2026-06-09');

    expect(rows.some((row) => row.post_type === 'lecture')).toBe(false);
    expect(rows).toEqual([
      expect.objectContaining({ post_type: 'general', category: '최신IT트렌드' }),
    ]);
    expect(mockedPgPool.run).not.toHaveBeenCalledWith(
      'blog',
      expect.stringContaining("'lecture'"),
      expect.any(Array),
    );
  });
});
