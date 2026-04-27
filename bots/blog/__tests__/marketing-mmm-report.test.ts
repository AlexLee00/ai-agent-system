'use strict';

const {
  buildWeeklyMmmReport,
  formatWeeklyMmmMarkdown,
} = require('../lib/omnichannel/marketing-mmm-report.ts');

describe('marketing-mmm-report', () => {
  test('ranks weekly channel contribution from channel snapshot rows', () => {
    const report = buildWeeklyMmmReport({
      channelPerformance: {
        rows: [
          {
            channel: 'instagram',
            status: 'ok',
            publishedCount: 2,
            views: 1000,
            comments: 16,
            likes: 120,
            revenueSignal: 0.4,
          },
          {
            channel: 'facebook',
            status: 'ok',
            publishedCount: 2,
            views: 200,
            comments: 3,
            likes: 20,
            revenueSignal: 0.1,
          },
        ],
      },
      snapshotTrend: { totalCount: 7 },
      autonomySummary: { totalCount: 14 },
      revenueCorrelation: {
        revenueImpactPct: 0.08,
        activeDay: { dayCount: 7 },
        inactiveDay: { dayCount: 7 },
      },
      socialPublishSources: { strategyNativeCount: 2, naverPostCount: 1 },
    }, { generatedAt: '2026-04-27T00:00:00.000Z' });

    expect(report.model).toBe('mmm-lite-weekly-v1');
    expect(report.confidenceLabel).toBe('high');
    expect(report.channels[0].channel).toBe('instagram');
    expect(report.channels[0].contributionScore).toBeGreaterThan(report.channels[1].contributionScore);
    expect(report.recommendations.join('\n')).toContain('instagram');
  });

  test('applies conservative decay and data-quality recommendation for low confidence', () => {
    const report = buildWeeklyMmmReport({
      channelPerformance: {
        rows: [
          {
            channel: 'instagram',
            status: 'watch',
            publishedCount: 0,
            views: 0,
            comments: 0,
            likes: 0,
          },
        ],
      },
      snapshotTrend: { totalCount: 0 },
      autonomySummary: { totalCount: 0 },
      revenueCorrelation: {
        activeDay: { dayCount: 0 },
        inactiveDay: { dayCount: 0 },
      },
      socialPublishSources: { strategyNativeCount: 0, naverPostCount: 3 },
    });

    expect(report.confidenceLabel).toBe('warming_up');
    expect(report.decayMultiplier).toBeLessThan(1);
    expect(report.recommendations.join('\n')).toContain('채널별 views/comments/revenue_signal');
    expect(report.recommendations.join('\n')).toContain('strategy_native');
  });

  test('routes permission-broken channels to recovery instead of contribution praise', () => {
    const report = buildWeeklyMmmReport({
      channelPerformance: {
        rows: [
          {
            channel: 'facebook',
            status: 'needs_permission',
            publishedCount: 8,
            views: 0,
            comments: 0,
            likes: 0,
          },
          {
            channel: 'instagram',
            status: 'warming_up',
            publishedCount: 1,
            views: 20,
            comments: 1,
            likes: 4,
          },
        ],
      },
      snapshotTrend: { totalCount: 7 },
      autonomySummary: { totalCount: 14 },
      revenueCorrelation: {
        activeDay: { dayCount: 7 },
        inactiveDay: { dayCount: 7 },
      },
    });

    const text = report.recommendations.join('\n');
    expect(text).toContain('facebook:needs_permission');
    expect(text).toContain('복구가 우선');
    expect(text).not.toContain('facebook 채널이 이번 주 추정 기여 1순위');
  });

  test('formats markdown report for operator review', () => {
    const report = buildWeeklyMmmReport({
      channelPerformance: { rows: [] },
      snapshotTrend: { totalCount: 0 },
      autonomySummary: { totalCount: 0 },
    }, { generatedAt: '2026-04-27T00:00:00.000Z' });

    const markdown = formatWeeklyMmmMarkdown(report);
    expect(markdown).toContain('Blog Weekly MMM-Lite Report');
    expect(markdown).toContain('No channel snapshot rows yet');
  });
});
