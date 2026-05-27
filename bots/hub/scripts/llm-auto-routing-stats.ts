// @ts-nocheck
'use strict';

// Auto-Router 10분 통계 집계 스크립트 (launchd: ai.hub.llm-auto-routing-monitor)
// Shadow 모드에서 Auto vs Manual 모델 분포 비교 + 비용 절감 추정

import path from 'node:path';
const PROJECT_ROOT = path.resolve(__dirname, '../../..');

async function main() {
  const { getRoutingStats } = require('../lib/llm/llm-auto-router');
  const { getPermissionStats } = require('../lib/permission-tiers');

  const [routing, permission] = await Promise.allSettled([
    getRoutingStats(1),  // 지난 1시간
    getPermissionStats(1),
  ]);

  const result = {
    ts: new Date().toISOString(),
    routing: routing.status === 'fulfilled' ? routing.value : { error: routing.reason?.message },
    permission: permission.status === 'fulfilled' ? permission.value : { error: permission.reason?.message },
  };

  console.log('[llm-auto-routing-stats]', JSON.stringify(result, null, 2));

  // 비용 절감 추정 (shadow 모드에서 haiku로 라우팅된 건을 sonnet 대비 비교)
  if (routing.status === 'fulfilled' && Array.isArray(routing.value?.rows)) {
    const rows = routing.value.rows as Array<Record<string, unknown>>;
    const haikuShadow = rows.filter((r) => r['auto_model'] === 'anthropic_haiku' && r['mode'] === 'shadow');
    const totalHaikuCalls = haikuShadow.reduce((s, r) => s + Number(r['total'] || 0), 0);

    if (totalHaikuCalls > 0) {
      // Haiku $0.8/1M input vs Sonnet $3/1M input — 약 3.75배 차이
      const estimatedSavingsRatio = 0.73;  // (3-0.8)/3
      console.log(`[비용 절감 추정] ${totalHaikuCalls}건 haiku 라우팅 → 추정 절감률 ${(estimatedSavingsRatio * 100).toFixed(0)}%`);
    }
  }
}

main().catch((e) => {
  console.error('[llm-auto-routing-stats] 오류:', e?.message || e);
  process.exit(1);
});
