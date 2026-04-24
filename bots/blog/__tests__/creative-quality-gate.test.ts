'use strict';

/**
 * creative-quality-gate 테스트
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');

jest.mock('../../../packages/core/lib/pg-pool', () => ({
  query: jest.fn().mockResolvedValue([]),
}));

const gate = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/omnichannel/creative-quality-gate.ts'));

describe('creative-quality-gate', () => {
  const baseVariant = {
    variant_id: 'var_gate_test',
    campaign_id: 'camp_gate',
    platform: 'instagram_reel',
    brand_axis: 'cafe_library',
    objective: 'conversion',
    title: '커피랑도서관 분당서현 스터디룸 예약',
    caption: `📚 지금 바로 스터디룸 예약하세요!\n\n커피랑도서관 분당서현점입니다.\n조용하고 집중되는 공간에서 공부하세요.\n\n▶ 예약 링크는 바이오에서!\n\n#스터디카페 #커피랑도서관 #분당서현 #서현역스터디카페`,
    cta: '▶ 예약 링크 바이오에서 확인',
    hashtags: ['#스터디카페', '#커피랑도서관', '#분당서현', '#서현역스터디카페'],
    asset_refs: null,
  };

  test('runCreativeQualityGate — 정상 variant 통과', () => {
    const result = gate.runCreativeQualityGate({
      variant: baseVariant,
      config: { accessToken: 'tok', igUserId: 'ig123' },
    });
    expect(result.scoreTotal).toBeGreaterThan(gate.GATE_THRESHOLD_BLOCK);
    expect(['passed', 'recoverable']).toContain(result.gateResult);
    expect(result.passed).toBe(true);
  });

  test('runCreativeQualityGate — 금지 표현 포함 시 policy_score 하락', () => {
    const badVariant = {
      ...baseVariant,
      caption: '무조건 100% 보장 부자 되는 스터디카페',
      title: '절대 실패 없는 공부 방법',
    };
    const result = gate.runCreativeQualityGate({ variant: badVariant, config: {} });
    expect(result.scores.policyScore).toBeLessThan(10);
    expect(result.reasons.blocked.length).toBeGreaterThan(0);
  });

  test('runCreativeQualityGate — 브랜드 키워드 없으면 brand_score 낮음', () => {
    const genericVariant = {
      ...baseVariant,
      caption: '일반적인 공부 팁을 알려드립니다',
      hashtags: ['#공부', '#tip'],
      brand_axis: 'cafe_library',
    };
    const result = gate.runCreativeQualityGate({ variant: genericVariant, config: {} });
    expect(result.scores.brandScore).toBeLessThan(15);
  });

  test('runCreativeQualityGate — instagram_reel assetRefs 없으면 api_readiness 낮음', () => {
    const noAssetVariant = {
      ...baseVariant,
      platform: 'instagram_reel',
      asset_refs: null,
    };
    const result = gate.runCreativeQualityGate({
      variant: noAssetVariant,
      config: { accessToken: 'tok', igUserId: 'ig123' },
    });
    // api_readiness는 full이 아님
    expect(result.reasons.recoverable.some(r => r.includes('prepare:instagram-media'))).toBe(true);
  });

  test('evaluateAndSaveQuality — dryRun 시 DB 저장 안 함', async () => {
    const pgPool = require('../../../packages/core/lib/pg-pool');
    const result = await gate.evaluateAndSaveQuality({
      variant: baseVariant,
      config: {},
      dryRun: true,
    });
    expect(result.gateResult).toBeDefined();
    expect(pgPool.query).not.toHaveBeenCalled();
  });
});
