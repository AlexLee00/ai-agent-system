'use strict';

/**
 * bots/blog/scripts/collect-all-signals.ts
 * 전체 신호 수집 실행 스크립트 (4시간 주기 launchd)
 *
 * Phase 5: signal-aggregator 실행 엔트리포인트
 * Kill Switch: BLOG_SIGNAL_COLLECTOR_ENABLED=true
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');

const BLOG_ROOT = path.join(env.PROJECT_ROOT, 'bots', 'blog');

async function main() {
  console.log('[신호수집] 시작 —', new Date().toISOString());

  try {
    const { aggregateAllSignals } = require(
      path.join(BLOG_ROOT, 'lib', 'signals', 'signal-aggregator')
    );

    const signals = await aggregateAllSignals();

    console.log('[신호수집] 완료');
    console.log(`  급상승 키워드: ${signals.trends.rising_keywords.join(', ') || '없음'}`);
    console.log(`  경쟁사 바이럴: ${signals.competitors.viral_detected}개`);
    console.log(`  브랜드 멘션: ${signals.brand_mentions.total_24h}건`);
    console.log(`  액션 힌트: ${signals.action_hints.length}개`);

    if (signals.action_hints.length > 0) {
      console.log('[신호수집] 힌트:');
      signals.action_hints.forEach((h: string) => console.log(' ', h));
    }
  } catch (e: any) {
    console.error('[신호수집] 오류:', e.message);
    process.exit(1);
  }
}

main();
