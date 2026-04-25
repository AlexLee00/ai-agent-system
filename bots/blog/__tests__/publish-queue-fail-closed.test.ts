'use strict';

jest.mock('../../../packages/core/lib/pg-pool', () => ({
  query: jest.fn().mockResolvedValue([]),
}));

jest.mock('../lib/omnichannel/marketing-os-schema.ts', () => ({
  ensureMarketingOsSchema: jest.fn().mockResolvedValue(undefined),
}));

const pgPool = require('../../../packages/core/lib/pg-pool');
const { ensureMarketingOsSchema } = require('../lib/omnichannel/marketing-os-schema.ts');
const queue = require('../lib/omnichannel/publish-queue.ts');

describe('publish-queue fail-closed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pgPool.query.mockResolvedValue([]);
    ensureMarketingOsSchema.mockResolvedValue(undefined);
  });

  test('claimNextPublishJob — schema/DB 오류 시 QueueUnavailableError throw', async () => {
    ensureMarketingOsSchema.mockRejectedValueOnce(new Error('schema_down'));

    await expect(
      queue.claimNextPublishJob('instagram_reel', { dryRun: false })
    ).rejects.toMatchObject({
      name: 'QueueUnavailableError',
      code: 'queue_unavailable',
    });
  });

  test('claimPublishJobByQueueId — schema/DB 오류 시 QueueUnavailableError throw', async () => {
    ensureMarketingOsSchema.mockRejectedValueOnce(new Error('schema_down'));

    await expect(
      queue.claimPublishJobByQueueId('q_test_1', { dryRun: false })
    ).rejects.toMatchObject({
      name: 'QueueUnavailableError',
      code: 'queue_unavailable',
    });
  });

  test('claimNextPublishJob — stale preparing 복구 및 retry exhaustion 차단 쿼리 선행', async () => {
    // stale 복구 update, retry 차단 update, claim update
    pgPool.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await queue.claimNextPublishJob('facebook_page', { dryRun: false });
    expect(result).toBeNull();
    expect(pgPool.query).toHaveBeenCalledTimes(3);
    expect(String(pgPool.query.mock.calls[0][1] || '')).toContain('stale_preparing_requeued');
    expect(String(pgPool.query.mock.calls[1][1] || '')).toContain('retry_exhausted');
  });

  test('claimNextPublishJob — schedule horizon 옵션을 claim 쿼리에 반영', async () => {
    pgPool.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await queue.claimNextPublishJob('instagram_reel', {
      dryRun: false,
      scheduleHorizonHours: 12,
    });

    expect(String(pgPool.query.mock.calls[2][1] || '')).toContain("($3::text || ' hours')::interval");
    expect(pgPool.query.mock.calls[2][2]).toEqual(['instagram_reel', false, 12]);
  });
});
