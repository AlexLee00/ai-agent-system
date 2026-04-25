'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');

jest.mock('../../../packages/core/lib/pg-pool', () => ({
  query: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../../packages/core/lib/meta-graph-config.ts', () => ({
  getMetaGraphConfig: jest.fn().mockResolvedValue({
    accessToken: 'meta_tok',
    pageId: 'page_1',
    apiVersion: 'v21.0',
    baseUrl: 'https://graph.facebook.com',
    instagram: {
      accessToken: 'ig_tok',
      igUserId: 'ig_1',
    },
    facebook: {
      accessToken: 'fb_tok',
      pageId: 'page_1',
    },
  }),
}));

const pgPool = require('../../../packages/core/lib/pg-pool');
const metaInsights = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/omnichannel/meta-insights.ts'));

describe('omnichannel meta insights', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pgPool.query.mockResolvedValue([]);
  });

  test('classifyGraphError — permission 에러 분류', () => {
    const classified = metaInsights.classifyGraphError(new Error(
      'Facebook Graph API 실패: HTTP 403 pages_manage_posts permission denied'
    ));
    expect(classified.needsPermission).toBe(true);
    expect(classified.permissionScopes).toContain('pages_manage_posts');
  });

  test('collectOmnichannelMetaInsights — dry-run에서 live fetch 생략', async () => {
    pgPool.query.mockResolvedValueOnce([
      { platform: 'instagram', success_count: 2, failed_count: 0 },
      { platform: 'facebook', success_count: 1, failed_count: 0 },
    ]);

    const payload = await metaInsights.collectOmnichannelMetaInsights({
      days: 7,
      date: '2026-04-25',
      dryRun: true,
    });

    expect(payload.metricDate).toBe('2026-04-25');
    expect(Array.isArray(payload.metricRows)).toBe(true);
    expect(payload.metricRows).toHaveLength(2);
    expect(payload.instagram.status).toBe('warming_up');
    expect(payload.facebook.status).toBe('warming_up');
    expect(payload.instagram.metadata.localSummary.successCount).toBe(2);
  });

  test('upsertMarketingChannelMetrics — variant null row 저장', async () => {
    pgPool.query.mockResolvedValue([]);
    const written = await metaInsights.upsertMarketingChannelMetrics([
      {
        variant_id: null,
        platform: 'instagram_reel',
        metric_date: '2026-04-25',
        reach: 10,
        impressions: 20,
        likes: 1,
        comments: 2,
        saves: 3,
        shares: 4,
        clicks: 5,
        profile_actions: 0,
        follows: 0,
        raw_payload: { test: true },
      },
    ], { dryRun: false });

    expect(written).toBe(1);
    expect(pgPool.query).toHaveBeenCalled();
  });
});
