'use strict';

/**
 * bots/blog/lib/ab-testing.ts
 * 플랫폼별 A/B 테스트 프레임워크
 *
 * Phase 4: 제목/톤/발행시간 A/B 테스트 + 통계적 유의성 검증
 */

const pgPool = require('../../../packages/core/lib/pg-pool');
const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');
const { runIfOps } = require('../../../packages/core/lib/mode-guard');

/**
 * A/B 테스트 생성
 * @param {object} config { platform, variant_a, variant_b, metric_target, hypothesis, sample_size_target }
 */
async function createAbTest(config) {
  const testId = `ab_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  try {
    await pgPool.query('blog', `
      INSERT INTO blog.ab_tests
        (test_id, platform, variant_a, variant_b, metric_target,
         hypothesis, sample_size_target, status, started_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', NOW())
    `, [
      testId,
      config.platform || 'naver',
      JSON.stringify(config.variant_a || {}),
      JSON.stringify(config.variant_b || {}),
      config.metric_target || 'views',
      config.hypothesis || '',
      config.sample_size_target || 100,
    ]);
    console.log(`[ab-testing] 테스트 생성: ${testId}`);
    return { test_id: testId, status: 'running' };
  } catch (err) {
    console.warn('[ab-testing] 테스트 생성 실패:', err.message);
    return null;
  }
}

/**
 * A/B 테스트 결과 기록
 * @param {string} testId
 * @param {'a'|'b'} variant
 * @param {number} metricValue
 */
async function recordAbTestResult(testId, variant, metricValue) {
  try {
    const col = variant === 'a' ? 'variant_a_score' : 'variant_b_score';
    const countCol = variant === 'a' ? 'variant_a_count' : 'variant_b_count';
    await pgPool.query('blog', `
      UPDATE blog.ab_tests
      SET ${col} = COALESCE(${col}, 0) + $1,
          ${countCol} = COALESCE(${countCol}, 0) + 1
      WHERE test_id = $2
    `, [metricValue, testId]);
  } catch {
    // 실패 무시
  }
}

/**
 * 간이 카이제곱 통계 유의성 (p < 0.05 기준)
 */
function chiSquareTest(aCount, bCount, aScore, bScore) {
  if (aCount < 5 || bCount < 5) return { significant: false, p_value: null, note: '샘플 부족' };

  const aAvg = aScore / aCount;
  const bAvg = bScore / bCount;
  const total = aCount + bCount;

  // 단순 z-test 근사
  const pooledP = (aScore + bScore) / total;
  const se = Math.sqrt(pooledP * (1 - pooledP) * (1 / aCount + 1 / bCount));
  if (se === 0) return { significant: false, p_value: null, note: '분산 없음' };

  const z = Math.abs(aAvg - bAvg) / se;
  const p = 2 * (1 - normalCdf(z));

  return {
    significant: p < 0.05,
    p_value: Number(p.toFixed(4)),
    z_score: Number(z.toFixed(3)),
    a_avg: Number(aAvg.toFixed(2)),
    b_avg: Number(bAvg.toFixed(2)),
    winner: p < 0.05 ? (aAvg > bAvg ? 'a' : 'b') : null,
  };
}

// 정규분포 누적분포함수 근사
function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  const cdf = 1 - pdf * poly;
  return z >= 0 ? cdf : 1 - cdf;
}

/**
 * A/B 테스트 결과 분석 + Telegram 보고
 * @param {string} testId
 */
async function analyzeAbTest(testId) {
  try {
    const rows = await pgPool.query('blog', `
      SELECT test_id, platform, variant_a, variant_b, metric_target, hypothesis,
             sample_size_target, status,
             COALESCE(variant_a_count, 0) AS a_count, COALESCE(variant_a_score, 0) AS a_score,
             COALESCE(variant_b_count, 0) AS b_count, COALESCE(variant_b_score, 0) AS b_score,
             started_at
      FROM blog.ab_tests
      WHERE test_id = $1
    `, [testId]);

    const test = rows?.[0];
    if (!test) return null;

    const aCount = Number(test.a_count || 0);
    const bCount = Number(test.b_count || 0);
    const aScore = Number(test.a_score || 0);
    const bScore = Number(test.b_score || 0);
    const targetN = Number(test.sample_size_target || 100);

    if (aCount < targetN / 2 || bCount < targetN / 2) {
      return { test_id: testId, status: 'running', note: '샘플 수집 중', a_count: aCount, b_count: bCount };
    }

    const stats = chiSquareTest(aCount, bCount, aScore, bScore);
    const newStatus = stats.significant ? 'completed' : 'inconclusive';

    // 상태 업데이트
    await pgPool.query('blog', `
      UPDATE blog.ab_tests SET status = $1, completed_at = NOW() WHERE test_id = $2
    `, [newStatus, testId]);

    if (stats.significant) {
      const variantA = typeof test.variant_a === 'string' ? JSON.parse(test.variant_a) : test.variant_a;
      const variantB = typeof test.variant_b === 'string' ? JSON.parse(test.variant_b) : test.variant_b;
      const winner = stats.winner === 'a' ? variantA : variantB;
      const msg = `🧪 [블로팀] A/B 테스트 완료\n`
        + `테스트: ${test.hypothesis}\n`
        + `승자: Variant ${(stats.winner || '?').toUpperCase()}\n`
        + `p값: ${stats.p_value} (유의미)\n`
        + `전략에 반영 권장: ${JSON.stringify(winner)}`;

      await runIfOps(
        `blog-ab-result-${testId}`,
        () => postAlarm({ message: msg, team: 'blog', bot: 'ab-testing', level: 'info' }),
        () => console.log('[DEV]', msg),
      ).catch(() => {});
    }

    return { test_id: testId, status: newStatus, stats };
  } catch (err) {
    console.warn('[ab-testing] 분석 실패:', err.message);
    return null;
  }
}

/**
 * 실행 중인 모든 A/B 테스트 일괄 분석 (launchd 호출용)
 */
async function analyzeAllActiveTests() {
  try {
    const rows = await pgPool.query('blog', `
      SELECT test_id FROM blog.ab_tests WHERE status = 'running'
    `);
    const results = [];
    for (const row of (rows || [])) {
      const result = await analyzeAbTest(row.test_id);
      if (result) results.push(result);
    }
    return results;
  } catch {
    return [];
  }
}

module.exports = {
  createAbTest,
  recordAbTestResult,
  analyzeAbTest,
  analyzeAllActiveTests,
  chiSquareTest,
};
